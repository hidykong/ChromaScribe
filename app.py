import copy
import csv
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
import uuid
import wave
from collections import defaultdict
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Event, Lock, Thread, RLock
from urllib.parse import unquote, urlparse

import docx2txt
import numpy as np
import pandas as pd
from config import REPO_ROOT, settings
from services import project_storage
from services.transcript_upload import save_transcript_upload
from services.transcript_undo import qna_state, qna_undo_token
from flask import (
    Flask,
    Response,
    abort,
    has_request_context,
    jsonify,
    make_response,
    redirect,
    render_template,
    request,
    send_from_directory,
    session,
    stream_with_context,
    url_for,
)

import processing_scripts.transcriptProcessing as transcriptProcessing
from processing_scripts.transcriptIdentity import normalize_participant_id
from processing_scripts.qwen import Qwen
from processing_scripts.qwenQnA import QwenQnA
from processing_scripts.qwenSimilarSentences import QwenSimilarSentence
from processing_scripts.non_verbal_audio_cues import detect_non_verbal_audio_cues

# Re-export helpers while existing project workflows still use app.py.
from services.storage import (
    _atomic_write_json,
    _file_sha1,
    _project_relative_storage_path,
    _json_file_has_content,
    _load_json_or_none,
    _read_json_if_exists,
    _load_json_payload_if_exists,
)

from services.analytics import (
    _safe_usage_log_key,
    _analysis_action_text_fingerprint,
)

from services.background_jobs import (
    _thread_workspace_key,
    _set_thread_workspace_key,
    _restore_thread_workspace_key,
    _persist_progress_state_file,
    _load_progress_state_file,
    TAGGING_PROGRESS_HEARTBEAT_SECONDS,
    TAGGING_PROGRESS_STALE_SECONDS,
    progress_lock,
    progress_store,
    running_jobs,
    running_jobs_lock,
    similar_excerpt_cancel_events,
    similar_excerpt_job_tasks,
    similar_excerpt_jobs,
    similar_excerpt_jobs_lock,
    similar_excerpt_tasks,
    similar_excerpt_update_lock,
)
from services.local_workspace import (
    LOCAL_WORKSPACE_KEY,
    initialize_local_session,
    is_local_session,
    local_request_error,
)

# Keep one application module when launched with `python app.py`.
# Blueprint imports must reuse its locks and job stores.
if __name__ == "__main__":
    sys.modules["app"] = sys.modules[__name__]

# Configuration is loaded before importing application workflows.
REPO_ENV_PATH = REPO_ROOT / ".env"
DATA_DIR = str(settings.data_dir)
PUBLIC_BASE_URL = settings.public_base_url
DEMO_ROUTE_PREFIX = "/demo"
ROUTE_SCOPE_SESSION_KEY = "route_scope"
SESSION_THEME_SUMMARY_TEXT_LIMIT = max(0, int(os.environ.get("CHROMA_SESSION_THEME_SUMMARY_TEXT_LIMIT", "240") or "240"))


# Locks for project mutations and local workspace preferences.
project_mutation_locks = {}
project_mutation_locks_lock = Lock()
workspace_preferences_lock = RLock()
PROJECT_SCOPED_SESSION_KEYS = (
    "themeObject",
    "themeObjectProjectId",
    "demographicsObject",
    "FileMap_MatchedData",
)


def _current_session_project_slot() -> str | None:
    if not has_request_context():
        return None
    session_id = session.get("session_id")
    if not session_id:
        return None
    return _safe_session_id(session_id)


def _clear_project_scoped_session_cache():
    if not has_request_context():
        return
    for key in PROJECT_SCOPED_SESSION_KEYS:
        session.pop(key, None)
    for key in list(session.keys()):
        if isinstance(key, str) and key.startswith("content_snapshot_hash::"):
            session.pop(key, None)


def _clear_project_scoped_session_cache_if_changed(
    previous_project_id: str | None,
    previous_mode: str | None,
    next_project_id: str | None,
    next_mode: str | None,
):
    if not has_request_context():
        return
    previous_project = _safe_project_id(previous_project_id) if previous_project_id else None
    next_project = _safe_project_id(next_project_id) if next_project_id else None
    previous_mode = previous_mode or "user"
    next_mode = next_mode or "user"
    if previous_project != next_project or previous_mode != next_mode:
        _clear_project_scoped_session_cache()

def _progress_owner_key(user_id: str | None, mode: str | None = None) -> str:
    resolved_mode = mode
    if resolved_mode is None:
        resolved_mode = session.get("mode", "user") if has_request_context() else "user"

    workspace_key = None
    if has_request_context():
        workspace_key = session.get("user_workspace_key")
    if not workspace_key:
        workspace_key = _thread_workspace_key()
    if isinstance(workspace_key, str) and workspace_key.strip():
        return f"workspace:{_safe_project_id(workspace_key)}"

    if has_request_context():
        user_key = session.get("user_key") or session.get("user")
        if isinstance(user_key, str) and user_key.strip():
            return f"user:{_safe_project_id(user_key)}"

    return f"session:{_safe_project_id(user_id or 'anonymous')}"


def _progress_store_key(user_id: str, project_id: str | None = None, mode: str | None = None) -> str:
    resolved_mode = mode
    if resolved_mode is None:
        if has_request_context():
            resolved_mode = session.get("mode", "user")
        else:
            resolved_mode = "user"

    resolved_project_id = project_id
    if resolved_project_id is None:
        if has_request_context():
            resolved_project_id = session.get("current_project_id")
        else:
            resolved_project_id = "default"
    safe_project_id = _safe_project_id(resolved_project_id)
    owner_key = _progress_owner_key(user_id, resolved_mode)
    if resolved_mode == "demo":
        return f"{owner_key}::demo::{safe_project_id}"
    return f"{owner_key}::user::{safe_project_id}"


def set_progress(user_id, stage, message="", extra=None, project_id: str | None = None, mode: str | None = None, status_path: str | None = None):
    updated_at = int(time.time())
    payload = {
        "stage": stage,
        "message": message,
        "updated_at": updated_at,
    }
    if extra:
        payload.update(extra)
    store_key = _progress_store_key(user_id, project_id=project_id, mode=mode)
    with progress_lock:
        progress_store[store_key] = payload

    resolved_status_path = status_path
    if resolved_status_path is None:
        try:
            resolved_mode = mode
            if resolved_mode is None and has_request_context():
                resolved_mode = session.get("mode", "user")
            if resolved_mode != "demo":
                resolved_project_id = project_id
                if resolved_project_id is None and has_request_context():
                    resolved_project_id = session.get("current_project_id")
                if resolved_project_id:
                    resolved_status_path = get_user_project_status_path(resolved_project_id)
        except Exception:
            resolved_status_path = None

    file_extra = dict(extra or {})
    file_extra["updated_at"] = updated_at
    _persist_progress_state_file(resolved_status_path, user_id, stage, message, extra=file_extra)


def get_progress_for_user(user_id, project_id: str | None = None, mode: str | None = None, status_path: str | None = None):
    default_payload = {"stage": 0, "message": "Not started"}
    store_key = _progress_store_key(user_id, project_id=project_id, mode=mode)
    with progress_lock:
        in_memory = progress_store.get(store_key)
    if in_memory:
        return in_memory

    resolved_status_path = status_path
    if resolved_status_path is None:
        try:
            resolved_mode = mode
            if resolved_mode is None and has_request_context():
                resolved_mode = session.get("mode", "user")
            if resolved_mode != "demo":
                resolved_project_id = project_id
                if resolved_project_id is None and has_request_context():
                    resolved_project_id = session.get("current_project_id")
                if resolved_project_id:
                    resolved_status_path = get_user_project_status_path(resolved_project_id)
        except Exception:
            resolved_status_path = None

    from_disk = _load_progress_state_file(resolved_status_path)
    return from_disk or default_payload


def _progress_extra_from_payload(progress_state: dict | None) -> dict:
    if not isinstance(progress_state, dict):
        return {}
    excluded_keys = {"stage", "message", "updated_at", "user_id"}
    return {
        key: value
        for key, value in progress_state.items()
        if key not in excluded_keys
    }


def _start_tagging_progress_heartbeat(
    user_id: str,
    project_id: str | None,
    mode: str | None,
    status_path: str | None,
) -> Event:
    stop_event = Event()

    def heartbeat():
        while not stop_event.wait(TAGGING_PROGRESS_HEARTBEAT_SECONDS):
            current = get_progress_for_user(
                user_id,
                project_id=project_id,
                mode=mode,
                status_path=status_path,
            )
            try:
                stage = int(current.get("stage", 0))
            except Exception:
                stage = 0
            if stage < 0 or stage >= 4:
                return
            message = str(current.get("message") or "Running").strip() or "Running"
            extra = _progress_extra_from_payload(current)
            extra["heartbeat_at"] = int(time.time())
            set_progress(
                user_id,
                stage,
                message,
                extra=extra,
                project_id=project_id,
                mode=mode,
                status_path=status_path,
            )

    Thread(target=heartbeat, daemon=True).start()
    return stop_event


def _generation_job_key(user_id: str, project_id: str | None = None, mode: str | None = None) -> str:
    return _progress_store_key(user_id, project_id=project_id, mode=mode)


def _request_project_id(default_project_id: str | None = None, payload: dict | None = None) -> str | None:
    raw_project_id = None
    explicit_project_id = False
    if has_request_context():
        raw_project_id = request.args.get("projectId") or request.args.get("project_id")
        explicit_project_id = bool(raw_project_id)
    if not raw_project_id and isinstance(payload, dict):
        raw_project_id = payload.get("projectId") or payload.get("project_id")
        explicit_project_id = bool(raw_project_id)
    if not raw_project_id:
        raw_project_id = default_project_id
    if not raw_project_id and has_request_context():
        raw_project_id = session.get("current_project_id")
    if not raw_project_id:
        return None

    safe_project_id = _safe_project_id(raw_project_id)
    if (
        has_request_context()
        and session.get("user")
        and session.get("mode", "user") != "demo"
        and explicit_project_id
    ):
        allowed_project_ids = [
            _safe_project_id(project.get("projectId"))
            for project in (session.get("user_projects", []) or [])
            if isinstance(project, dict) and project.get("projectId")
        ]
        allowed_project_id_set = set(allowed_project_ids)
        if allowed_project_id_set and safe_project_id not in allowed_project_id_set:
            fallback_project_id = _safe_project_id(default_project_id or session.get("current_project_id"))
            if fallback_project_id in allowed_project_id_set:
                return fallback_project_id
            return allowed_project_ids[0]
    return safe_project_id


def _theme_job_key(user_id: str, theme: str, project_id: str | None = None, mode: str | None = None) -> str:
    normalized_theme = re.sub(r"\s+", " ", str(theme or "").strip().lower()) or "theme"
    return f"{_generation_job_key(user_id, project_id=project_id, mode=mode)}::theme::{normalized_theme}"


def _resolve_project_runtime_dirs(mode: str | None = None, project_id: str | None = None) -> dict[str, str | None]:
    resolved_mode = mode
    if resolved_mode is None:
        resolved_mode = session.get("mode", "user") if has_request_context() else "user"

    if resolved_mode == "demo":
        demo_intermediate_dir = None
        if has_request_context() and session.get("user"):
            demo_intermediate_dir = get_user_project_intermediate_dir(_user_demo_project_id(project_id))
        return {
            "processed_dir": get_demo_project_outputs_dir(project_id),
            "uploads_dir": get_demo_project_uploads_dir(project_id),
            "intermediate_dir": demo_intermediate_dir,
        }

    return {
        "processed_dir": get_user_project_processed_dir(project_id),
        "uploads_dir": get_user_project_uploads_dir(project_id),
        "intermediate_dir": get_user_project_intermediate_dir(project_id),
    }


def _stable_json_hash(value) -> str:
    try:
        payload = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    except TypeError:
        payload = json.dumps(str(value), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _strip_transient_filemap_fields(value):
    if isinstance(value, dict):
        return {
            key: _strip_transient_filemap_fields(item)
            for key, item in value.items()
            if key not in {"file"}
        }
    if isinstance(value, list):
        return [_strip_transient_filemap_fields(item) for item in value]
    return value


def _uploaded_input_manifest(uploads_dir: str | None) -> list[dict]:
    if not uploads_dir:
        return []
    root = Path(uploads_dir)
    if not root.exists():
        return []

    manifest: list[dict] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        rel_path = path.relative_to(root)
        if any(part.startswith(".") for part in rel_path.parts):
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        manifest.append({
            "path": rel_path.as_posix(),
            "size": stat.st_size,
            "mtimeNs": stat.st_mtime_ns,
        })
    return manifest


def _tagging_input_signature(
    mode: str | None = None,
    project_id: str | None = None,
    uploads_dir: str | None = None,
    file_map: dict | None = None,
) -> dict:
    resolved_mode = mode or ("user" if not has_request_context() else session.get("mode", "user"))
    runtime_dirs = _resolve_project_runtime_dirs(resolved_mode, project_id)
    resolved_uploads_dir = uploads_dir or runtime_dirs.get("uploads_dir")
    resolved_file_map = file_map
    if resolved_file_map is None and resolved_mode != "demo":
        resolved_file_map = _load_filemap_payload(get_filemap_path_for_project(project_id)) or {"participants": []}

    normalized_file_map = _strip_transient_filemap_fields(resolved_file_map or {"participants": []})
    file_map_hash = _stable_json_hash(normalized_file_map)
    uploads_manifest = _uploaded_input_manifest(resolved_uploads_dir)
    payload = {
        "mode": resolved_mode,
        "projectId": _safe_project_id(project_id) if project_id else None,
        "fileMapHash": file_map_hash,
        "fileMap": normalized_file_map,
        "uploads": uploads_manifest,
    }
    return {
        "hash": _stable_json_hash(payload),
        "fileMapHash": file_map_hash,
        "fileCount": len(uploads_manifest),
    }


def _tagging_progress_extra(input_signature: dict | None = None) -> dict:
    if not isinstance(input_signature, dict):
        return {}
    return {
        "inputHash": input_signature.get("hash"),
        "fileMapHash": input_signature.get("fileMapHash"),
        "inputFileCount": input_signature.get("fileCount"),
    }


def _mark_tagging_run_started(project_id: str | None, input_signature: dict | None, job_key: str | None = None):
    if not project_id or not isinstance(input_signature, dict):
        return

    def mutator(meta: dict) -> bool:
        changed = False
        updates = {
            "tagging_run_status": "running",
            "tagging_input_hash": input_signature.get("hash"),
            "tagging_filemap_hash": input_signature.get("fileMapHash"),
            "tagging_input_file_count": input_signature.get("fileCount"),
            "tagging_started_at": int(time.time()),
            "tagging_job_key": job_key,
        }
        for key, value in updates.items():
            if meta.get(key) != value:
                meta[key] = value
                changed = True
        workflow = meta.get("workflow_state")
        if not isinstance(workflow, dict):
            workflow = {}
        steps = workflow.get("steps")
        if not isinstance(steps, dict):
            steps = {}
        step_record = {
            "step": "tagging_running",
            "updated_at": updates["tagging_started_at"],
            "jobKey": job_key,
            "inputHash": input_signature.get("hash"),
            "inputFileCount": input_signature.get("fileCount"),
        }
        steps["tagging_running"] = step_record
        workflow.update({
            "current_step": "tagging_running",
            "last_step": "tagging_running",
            "last_updated_at": updates["tagging_started_at"],
            "steps": steps,
        })
        if has_request_context():
            workflow["last_session_id"] = session.get("session_id")
        if meta.get("workflow_state") != workflow:
            meta["workflow_state"] = workflow
            changed = True
        if meta.get("tagging_completed_at") is not None:
            meta["tagging_completed_at"] = None
            changed = True
        return changed

    _update_project_meta(project_id, mutator)


def _mark_tagging_run_complete(project_id: str | None, input_signature: dict | None):
    if not project_id or not isinstance(input_signature, dict):
        return

    def mutator(meta: dict) -> bool:
        changed = False
        updates = {
            "tagging_run_status": "complete",
            "tagging_input_hash": input_signature.get("hash"),
            "tagging_filemap_hash": input_signature.get("fileMapHash"),
            "tagging_input_file_count": input_signature.get("fileCount"),
            "tagging_completed_at": int(time.time()),
        }
        for key, value in updates.items():
            if meta.get(key) != value:
                meta[key] = value
                changed = True
        workflow = meta.get("workflow_state")
        if not isinstance(workflow, dict):
            workflow = {}
        steps = workflow.get("steps")
        if not isinstance(steps, dict):
            steps = {}
        step_record = {
            "step": "tagging_complete",
            "updated_at": updates["tagging_completed_at"],
            "inputHash": input_signature.get("hash"),
            "inputFileCount": input_signature.get("fileCount"),
        }
        steps["tagging_complete"] = step_record
        workflow.update({
            "current_step": "tagging_complete",
            "last_step": "tagging_complete",
            "last_updated_at": updates["tagging_completed_at"],
            "steps": steps,
        })
        if has_request_context():
            workflow["last_session_id"] = session.get("session_id")
        if meta.get("workflow_state") != workflow:
            meta["workflow_state"] = workflow
            changed = True
        return changed

    _update_project_meta(project_id, mutator)


def _tagging_output_ready(mode: str | None = None, project_id: str | None = None) -> bool:
    resolved_mode = mode or ("user" if not has_request_context() else session.get("mode", "user"))
    output_path = get_demo_output_json_path(project_id) if resolved_mode == "demo" else get_user_output_json_path(project_id)
    try:
        return bool(output_path and os.path.exists(output_path) and os.path.getsize(output_path) > 0)
    except OSError:
        return False


def _tagging_progress_recently_running(progress_state: dict | None) -> bool:
    if not isinstance(progress_state, dict):
        return False
    normalized = _normalize_progress_payload(progress_state, output_ready=False)
    if not normalized.get("running"):
        return False
    updated_at = progress_state.get("updated_at")
    if not updated_at:
        return True
    try:
        return (time.time() - float(updated_at)) <= TAGGING_PROGRESS_STALE_SECONDS
    except (TypeError, ValueError):
        return True


def _tagging_start_state(
    user_id: str,
    mode: str | None,
    project_id: str | None,
    status_path: str | None,
    input_signature: dict | None,
    job_key: str,
) -> dict:
    progress_state = get_progress_for_user(
        user_id,
        project_id=project_id,
        mode=mode,
        status_path=status_path,
    )
    with running_jobs_lock:
        job_in_memory = job_key in running_jobs

    if job_in_memory or _tagging_progress_recently_running(progress_state):
        return {
            "status": "already_running",
            "progress": progress_state,
            "inputChanged": bool(
                isinstance(input_signature, dict)
                and progress_state.get("inputHash")
                and progress_state.get("inputHash") != input_signature.get("hash")
            ),
        }

    if isinstance(input_signature, dict):
        input_hash = input_signature.get("hash")
        try:
            progress_stage = int(progress_state.get("stage", 0))
        except (TypeError, ValueError):
            progress_stage = 0
        if (
            input_hash
            and progress_state.get("inputHash") == input_hash
            and progress_stage >= 4
            and _tagging_output_ready(mode=mode, project_id=project_id)
        ):
            return {
                "status": "up_to_date",
                "progress": progress_state,
                "inputChanged": False,
            }

    if mode != "demo" and isinstance(input_signature, dict):
        meta = _ensure_project_storage_meta(project_id)
        input_hash = input_signature.get("hash")
        if (
            input_hash
            and meta.get("tagging_input_hash") == input_hash
            and meta.get("tagging_run_status") == "complete"
            and _tagging_output_ready(mode=mode, project_id=project_id)
        ):
            return {
                "status": "up_to_date",
                "progress": progress_state,
                "inputChanged": False,
            }

    return {
        "status": "should_start",
        "progress": progress_state,
        "inputChanged": False,
    }


def _build_qwen_runtime(mode: str | None = None, project_id: str | None = None, processed_dir: str | None = None, intermediate_dir: str | None = None) -> Qwen:
    runtime_dirs = _resolve_project_runtime_dirs(mode, project_id)
    return Qwen(
        processed_dir=processed_dir or runtime_dirs.get("processed_dir"),
        intermediate_dir=intermediate_dir or runtime_dirs.get("intermediate_dir"),
    )


def _build_qna_runtime(mode: str | None = None, project_id: str | None = None, processed_dir: str | None = None, uploads_dir: str | None = None, intermediate_dir: str | None = None) -> QwenQnA:
    runtime_dirs = _resolve_project_runtime_dirs(mode, project_id)
    return QwenQnA(
        processed_dir=processed_dir or runtime_dirs.get("processed_dir"),
        uploaded_dir=uploads_dir or runtime_dirs.get("uploads_dir"),
        intermediate_dir=intermediate_dir or runtime_dirs.get("intermediate_dir"),
    )


def _build_similar_sentences_runtime(
    mode: str | None = None,
    project_id: str | None = None,
    processed_dir: str | None = None,
    allowed_source_files: list[str] | set[str] | None = None,
) -> QwenSimilarSentence:
    runtime_dirs = _resolve_project_runtime_dirs(mode, project_id)
    return QwenSimilarSentence(
        processed_dir=processed_dir or runtime_dirs.get("processed_dir"),
        allowed_source_files=allowed_source_files,
    )


def _filemap_assigned_transcript_output_keys(input_directory: str | None, file_map: dict | None) -> set[str]:
    if not input_directory or not isinstance(file_map, dict):
        return set()
    output_keys: set[str] = set()
    resolved_output_keys = transcriptProcessing.transcript_output_keys_by_path(input_directory, file_map)
    participants = file_map.get("participants") if isinstance(file_map.get("participants"), list) else []
    for participant in participants:
        if not isinstance(participant, dict):
            continue
        transcript_info = participant.get("transcript") if isinstance(participant.get("transcript"), dict) else {}
        relative_path = str(
            transcript_info.get("relativePath")
            or transcript_info.get("originalFilename")
            or ""
        ).replace("\\", "/").lstrip("/")
        if not relative_path:
            continue
        base, ext = os.path.splitext(relative_path)
        candidates = [relative_path, f"{base}_from_docx.txt"] if ext.lower() == ".docx" else [relative_path]
        for candidate in candidates:
            if candidate in resolved_output_keys:
                output_keys.add(resolved_output_keys[candidate])
                break
    return output_keys


def _current_uploaded_transcript_output_keys(
    *,
    mode: str | None,
    project_id: str | None,
    uploads_dir: str | None = None,
    file_map: dict | None = None,
) -> set[str]:
    if mode == "demo":
        return set()
    runtime_dirs = _resolve_project_runtime_dirs(mode, project_id)
    resolved_uploads_dir = uploads_dir or runtime_dirs.get("uploads_dir")
    resolved_file_map = file_map
    if resolved_file_map is None:
        resolved_file_map = _load_filemap_payload(get_filemap_path_for_project(project_id)) or {"participants": []}

    assigned_keys = _filemap_assigned_transcript_output_keys(resolved_uploads_dir, resolved_file_map)
    if assigned_keys:
        return assigned_keys
    if not resolved_uploads_dir:
        return set()
    return transcriptProcessing.expected_transcript_output_keys(
        resolved_uploads_dir,
        resolved_file_map if isinstance(resolved_file_map, dict) else {"participants": []},
    )


def _normalize_similar_excerpt_theme_key(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").replace("_", " ").lower()).strip()


def _resolve_similar_excerpt_theme_key(themes_data: dict | None, theme_name: str | None) -> str | None:
    if not isinstance(themes_data, dict):
        return None
    if theme_name in themes_data:
        return theme_name
    normalized_target = _normalize_similar_excerpt_theme_key(theme_name)
    for key in themes_data.keys():
        if _normalize_similar_excerpt_theme_key(key) == normalized_target:
            return key
    return None


def _count_ai_generated_quotes_for_theme(processed_dir: str | None, theme_name: str | None) -> int:
    if not processed_dir or not theme_name:
        return 0
    output_json_path = os.path.join(processed_dir, "ai_generated.json")
    if not os.path.exists(output_json_path):
        return 0
    try:
        with open(output_json_path, "r", encoding="utf-8") as f:
            themes_data = json.load(f) or {}
        theme_key = _resolve_similar_excerpt_theme_key(themes_data, theme_name)
        if not theme_key:
            return 0
        quotes = themes_data.get(theme_key, {}).get("quotes", [])
        return len(quotes) if isinstance(quotes, list) else 0
    except Exception as e:
        print(f"[WARN] Could not count similar excerpt quotes for {theme_name}: {e}")
        return 0


def _update_similar_excerpt_task(task_id: str, **fields):
    payload = dict(similar_excerpt_tasks.get(task_id, {}))
    payload.update(fields)
    payload["updatedAt"] = datetime.now(timezone.utc).isoformat()
    similar_excerpt_tasks[task_id] = payload
    return payload


def generate_similar_sentences_background(
    task_id,
    theme,
    chosen_themes,
    mode="user",
    project_id=None,
    processed_dir=None,
    job_key=None,
    cancel_event=None,
    workspace_key: str | None = None,
    source_files: list[str] | set[str] | None = None,
):
    previous_workspace_key = _set_thread_workspace_key(workspace_key)
    runtime_dirs = _resolve_project_runtime_dirs(mode, project_id)
    resolved_processed_dir = processed_dir or runtime_dirs.get("processed_dir")
    resolved_source_files = sorted(
        {
            str(source_file or "").replace("\\", "/").strip()
            for source_file in (source_files or [])
            if str(source_file or "").strip()
        },
        key=lambda value: value.lower(),
    )
    resolved_cancel_event = cancel_event or similar_excerpt_cancel_events.get(task_id)

    def is_cancelled():
        return bool(resolved_cancel_event and resolved_cancel_event.is_set())

    def mark_cancelled(message="Similar excerpt search stopped."):
        current_progress = 0
        try:
            current_progress = int(similar_excerpt_tasks.get(task_id, {}).get("progressPercent") or 0)
        except Exception:
            current_progress = 0
        _update_similar_excerpt_task(
            task_id,
            status="cancelled",
            phase="cancelled",
            message=message,
            theme=theme,
            progressPercent=max(0, min(99, current_progress)),
            cancelled=True,
            sourceFiles=resolved_source_files,
        )

    def progress_callback(progress):
        if is_cancelled():
            _update_similar_excerpt_task(
                task_id,
                status="cancelling",
                phase="cancelling",
                message="Stopping similar excerpt search.",
                theme=theme,
                cancelRequested=True,
            )
            return
        progress = progress if isinstance(progress, dict) else {}
        _update_similar_excerpt_task(
            task_id,
            status="processing",
            phase=str(progress.get("phase") or "scanning"),
            message=str(progress.get("message") or "Scanning transcripts for semantically similar excerpts."),
            theme=theme,
            progressPercent=max(0, min(99, int(progress.get("progressPercent") or 0))),
            processedChunks=int(progress.get("processedChunks") or 0),
            totalChunks=int(progress.get("totalChunks") or 0),
            matchesFound=int(progress.get("matchesFound") or 0),
            transcriptCount=int(progress.get("transcriptCount") or 0),
            sourceFiles=progress.get("sourceFiles") if isinstance(progress.get("sourceFiles"), list) else resolved_source_files,
        )

    try:
        print(f"Started similar-excerpt background job for theme: {theme}")
        if is_cancelled():
            mark_cancelled()
            return
        before_count = _count_ai_generated_quotes_for_theme(resolved_processed_dir, theme)
        _update_similar_excerpt_task(
            task_id,
            status="processing",
            phase="scanning",
            message="Scanning transcripts for semantically similar excerpts.",
            theme=theme,
            beforeQuoteCount=before_count,
            progressPercent=0,
            processedChunks=0,
            totalChunks=0,
            sourceFiles=resolved_source_files,
        )

        qwen_ss = _build_similar_sentences_runtime(
            mode,
            project_id,
            processed_dir=resolved_processed_dir,
            allowed_source_files=resolved_source_files,
        )
        qwen = _build_qwen_runtime(mode, project_id, processed_dir=resolved_processed_dir)
        with similar_excerpt_update_lock:
            result = qwen_ss.find_similar_sentences(
                theme,
                progress_callback=progress_callback,
                cancel_event=resolved_cancel_event,
            )
            if is_cancelled() or (isinstance(result, dict) and result.get("cancelled")):
                mark_cancelled()
                return
            _update_similar_excerpt_task(
                task_id,
                status="processing",
                phase="refreshing",
                message="Refreshing the matching excerpt list.",
                theme=theme,
                progressPercent=95,
            )
            if is_cancelled():
                mark_cancelled()
                return
            topics = qwen.get_topic_for_themes_qwen(chosen_themes, processed_dir=resolved_processed_dir)
            if is_cancelled():
                mark_cancelled()
                return

        after_count = _count_ai_generated_quotes_for_theme(resolved_processed_dir, theme)
        matches = result.get("matches", []) if isinstance(result, dict) else (result if isinstance(result, list) else [])
        added_count = result.get("addedQuoteCount") if isinstance(result, dict) else None
        if not isinstance(added_count, int):
            added_count = max(0, after_count - before_count)
        result_source_files = result.get("sourceFiles") if isinstance(result, dict) and isinstance(result.get("sourceFiles"), list) else resolved_source_files
        result_code_source_files = result.get("codeSourceFiles") if isinstance(result, dict) and isinstance(result.get("codeSourceFiles"), list) else []

        _update_similar_excerpt_task(
            task_id,
            status="done",
            phase="done",
            message="Similar excerpt search finished.",
            theme=theme,
            topics=topics,
            matchesFound=len(matches),
            addedQuoteCount=added_count,
            beforeQuoteCount=before_count,
            afterQuoteCount=after_count,
            progressPercent=100,
            reason=result.get("reason") if isinstance(result, dict) else "",
            sourceFiles=result_source_files,
            codeSourceFiles=result_code_source_files,
        )

    except Exception as e:
        print(f"[ERROR] Similar excerpt job failed for {theme}: {e}")
        if is_cancelled() or str(e) == "similar_excerpt_cancelled":
            mark_cancelled()
        else:
            _update_similar_excerpt_task(
                task_id,
                status="error",
                phase="error",
                message=str(e),
                theme=theme,
            )

    finally:
        _restore_thread_workspace_key(previous_workspace_key)
        with similar_excerpt_jobs_lock:
            similar_excerpt_jobs.discard(job_key or theme)
            similar_excerpt_job_tasks.pop(job_key or theme, None)
            similar_excerpt_cancel_events.pop(task_id, None)
        print(f"Finished similar-excerpt background job for theme: {theme}")


def _processed_transcript_keys(output_directory: str | None) -> set[str]:
    if not output_directory:
        return set()
    transcript_path = os.path.join(output_directory, "all_transcripts_processed.json")
    if not os.path.exists(transcript_path):
        return set()
    try:
        with open(transcript_path, "r", encoding="utf-8") as f:
            payload = json.load(f)
        return set(payload.keys()) if isinstance(payload, dict) else set()
    except Exception as e:
        print(f"[WARN] Could not inspect processed transcripts at {transcript_path}: {e}")
        return set()


PRESERVED_TRANSCRIPT_REASON_UNMATCHED = "unmatched_file_after_partial_processing"
PRESERVED_TRANSCRIPT_METADATA = {
    "manualCodingPreserved": True,
    "manualCodingPreservedReason": PRESERVED_TRANSCRIPT_REASON_UNMATCHED,
    "skipAiTagging": True,
}
MANUAL_TRANSCRIPT_CUE_FIELDS = {
    "manualTag",
    "tagUpdatedAt",
    "tagConflict",
    "tagConflictType",
    "tagConflictResolution",
    "tagConflictResolvedAt",
    "tagConflictResolvedManualTag",
    "tagConflictResolvedAiTag",
    "additionalTags",
}
BASE_TRANSCRIPT_CUE_FIELDS = {
    "speaker",
    "timestamp",
    "script",
    "lineNumber",
    "transcriptIndex",
}


def _load_processed_transcripts_payload(output_directory: str | None) -> dict:
    if not output_directory:
        return {}
    transcript_path = os.path.join(output_directory, "all_transcripts_processed.json")
    if not os.path.exists(transcript_path):
        return {}
    try:
        with open(transcript_path, "r", encoding="utf-8") as f:
            payload = json.load(f)
        return payload if isinstance(payload, dict) else {}
    except Exception as e:
        print(f"[WARN] Could not load processed transcripts from {transcript_path}: {e}")
        return {}


def _write_processed_transcripts_payload(output_directory: str | None, payload: dict) -> None:
    if not output_directory:
        return
    transcript_path = os.path.join(output_directory, "all_transcripts_processed.json")
    os.makedirs(os.path.dirname(transcript_path), exist_ok=True)
    with open(transcript_path, "w", encoding="utf-8") as f:
        json.dump(payload if isinstance(payload, dict) else {}, f, indent=4, ensure_ascii=False)


def _cue_has_manual_qna_state(cue: dict | None) -> bool:
    if not isinstance(cue, dict):
        return False
    source = str(cue.get("tagSource") or "").strip().lower()
    return source in {"manual", "human"} or "manualTag" in cue


def _cue_lookup_keys(cue: dict | None, index: int | None = None) -> list[tuple[str, str]]:
    if not isinstance(cue, dict):
        return []
    timestamp = str(cue.get("timestamp") or "").strip()
    script_key = re.sub(r"\s+", " ", str(cue.get("script") or "").strip()).casefold()
    speaker_key = re.sub(r"\s+", " ", str(cue.get("speaker") or "").strip()).casefold()
    keys: list[tuple[str, str]] = []
    if cue.get("segmentId"):
        keys.append(("segment_id", str(cue["segmentId"])))
    if timestamp and script_key:
        keys.append(("timestamp_script", f"{timestamp}||{script_key}"))
    if timestamp and speaker_key:
        keys.append(("timestamp_speaker", f"{timestamp}||{speaker_key}"))
    if timestamp:
        keys.append(("timestamp", timestamp))
    transcript_index = cue.get("transcriptIndex")
    if transcript_index is not None:
        keys.append(("transcript_index", str(transcript_index)))
    line_number = cue.get("lineNumber")
    if line_number is not None:
        keys.append(("line_number", str(line_number)))
    if index is not None:
        keys.append(("position", str(index)))
    return keys


def _find_matching_previous_cue(
    previous_cues: list,
    previous_cue_indexes: dict[tuple[str, str], list[int]],
    used_indexes: set[int],
    cue: dict,
    index: int,
) -> dict | None:
    for key in _cue_lookup_keys(cue, index):
        for previous_index in previous_cue_indexes.get(key, []):
            if previous_index in used_indexes:
                continue
            previous_cue = previous_cues[previous_index]
            if isinstance(previous_cue, dict):
                used_indexes.add(previous_index)
                return previous_cue
    return None


def _build_previous_cue_indexes(previous_cues: list) -> dict[tuple[str, str], list[int]]:
    indexes: dict[tuple[str, str], list[int]] = {}
    for index, cue in enumerate(previous_cues):
        for key in _cue_lookup_keys(cue, index):
            indexes.setdefault(key, []).append(index)
    return indexes


def _merge_cue_preserving_manual_state(new_cue: dict, previous_cue: dict | None) -> dict:
    if not isinstance(new_cue, dict):
        return new_cue
    if not isinstance(previous_cue, dict):
        return new_cue

    merged_cue = dict(new_cue)
    if previous_cue.get("textEditedByUser"):
        merged_cue["script"] = previous_cue.get("script", new_cue.get("script", ""))
        merged_cue["textEditedByUser"] = True
    if previous_cue.get("speakerRoleSource") == "manual":
        for field in ("speaker", "speakerLabel", "speakerRole", "speakerRoleSource"):
            if field in previous_cue:
                merged_cue[field] = previous_cue[field]
    previous_has_manual_qna = _cue_has_manual_qna_state(previous_cue)
    if previous_has_manual_qna:
        merged_cue["tag"] = previous_cue.get("manualTag", previous_cue.get("tag", "None")) or "None"
        merged_cue["manualTag"] = previous_cue.get("manualTag", previous_cue.get("tag", "None")) or "None"
        merged_cue["tagSource"] = "manual"

    for key in MANUAL_TRANSCRIPT_CUE_FIELDS:
        if key in previous_cue:
            merged_cue[key] = copy.deepcopy(previous_cue[key])

    # Preserve user-facing per-cue state that is not produced by raw transcript parsing.
    # This covers manual-code count fields added by transcript mode without keeping
    # stale AI tags on current files.
    for key, value in previous_cue.items():
        if key in merged_cue or key in BASE_TRANSCRIPT_CUE_FIELDS:
            continue
        if key in {"tag", "tagSource", "aiSuggestedTag"}:
            continue
        merged_cue[key] = copy.deepcopy(value)

    return merged_cue


def _merge_transcript_record_preserving_manual_state(new_record: dict, previous_record: dict | None) -> dict:
    if not isinstance(new_record, dict) or not isinstance(previous_record, dict):
        return new_record

    merged_record = dict(new_record)
    previous_cues = previous_record.get("transcript", [])
    new_cues = new_record.get("transcript", [])
    if isinstance(previous_cues, list) and isinstance(new_cues, list):
        previous_cue_indexes = _build_previous_cue_indexes(previous_cues)
        used_previous_indexes: set[int] = set()
        merged_record["transcript"] = [
            _merge_cue_preserving_manual_state(
                cue,
                _find_matching_previous_cue(
                    previous_cues,
                    previous_cue_indexes,
                    used_previous_indexes,
                    cue,
                    index,
                ),
            )
            if isinstance(cue, dict)
            else cue
            for index, cue in enumerate(new_cues)
        ]

    return merged_record


def _transcript_record_source_identity(file_key: str, record: dict) -> str:
    """Compare original DOCX uploads with their older extracted TXT filenames."""
    source = record.get("sourceFile") or file_key
    normalized = str(source or "").replace("\\", "/").removeprefix("./")
    legacy_suffix = "_from_docx.txt"
    if normalized.lower().endswith(legacy_suffix):
        return normalized[:-len(legacy_suffix)] + ".docx"
    return normalized


def _merge_processed_transcripts_preserving_manual_state(
    generated_payload: dict | None,
    previous_payload: dict | None,
) -> tuple[dict, dict]:
    generated = generated_payload if isinstance(generated_payload, dict) else {}
    previous = previous_payload if isinstance(previous_payload, dict) else {}
    if not previous:
        return generated, {"preservedUnmatchedCount": 0, "mergedCurrentCount": 0}

    # Reserve exact matches first. A renamed legacy entry must not take manual
    # state that already belongs to another current transcript.
    previous_keys_by_current = {
        file_key: file_key
        for file_key, record in generated.items()
        if isinstance(record, dict) and isinstance(previous.get(file_key), dict)
    }
    consumed_previous_keys = set(previous_keys_by_current.values())
    candidates_by_current = {}
    for file_key, record in generated.items():
        if file_key in previous_keys_by_current or not isinstance(record, dict):
            continue
        source_identity = _transcript_record_source_identity(file_key, record)
        candidate_keys = []
        for previous_key, previous_record in previous.items():
            if previous_key in consumed_previous_keys or not isinstance(previous_record, dict):
                continue
            previous_identity = _transcript_record_source_identity(previous_key, previous_record)
            same_source = source_identity == previous_identity
            # Older DOCX imports had only a basename key, with no sourceFile.
            # Accept its known conversion alias when full paths do not conflict.
            same_conversion_name = (
                _transcript_record_source_identity(file_key, {})
                == _transcript_record_source_identity(previous_key, {})
            )
            conflicting_sources = (
                record.get("sourceFile")
                and previous_record.get("sourceFile")
                and not same_source
            )
            if same_source or (same_conversion_name and not conflicting_sources):
                candidate_keys.append(previous_key)
        candidates_by_current[file_key] = candidate_keys

    for file_key, candidate_keys in candidates_by_current.items():
        if len(candidate_keys) != 1:
            continue
        previous_key = candidate_keys[0]
        matching_current_count = sum(
            previous_key in candidates for candidates in candidates_by_current.values()
        )
        if matching_current_count == 1:
            previous_keys_by_current[file_key] = previous_key
            consumed_previous_keys.add(previous_key)

    merged: dict = {}
    merged_current_count = 0
    for file_key, generated_record in generated.items():
        if not isinstance(generated_record, dict):
            merged[file_key] = generated_record
            continue
        previous_record = previous.get(previous_keys_by_current.get(file_key))
        if isinstance(previous_record, dict):
            merged[file_key] = _merge_transcript_record_preserving_manual_state(
                generated_record,
                previous_record,
            )
            merged_current_count += 1
        else:
            merged[file_key] = generated_record

    preserved_count = 0
    preserved_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    for file_key, previous_record in previous.items():
        if file_key in merged or file_key in consumed_previous_keys:
            continue
        if not isinstance(previous_record, dict):
            continue
        preserved_record = copy.deepcopy(previous_record)
        preserved_record.update(PRESERVED_TRANSCRIPT_METADATA)
        preserved_record["manualCodingPreservedAt"] = preserved_record.get("manualCodingPreservedAt") or preserved_at
        merged[file_key] = preserved_record
        preserved_count += 1

    return merged, {
        "preservedUnmatchedCount": preserved_count,
        "mergedCurrentCount": merged_current_count,
    }


def _remove_preserved_transcript_metadata(record: dict) -> bool:
    if not isinstance(record, dict):
        return False
    if record.get("manualCodingPreservedReason") != PRESERVED_TRANSCRIPT_REASON_UNMATCHED:
        return False
    changed = False
    for key in (*PRESERVED_TRANSCRIPT_METADATA.keys(), "manualCodingPreservedAt"):
        if key in record:
            record.pop(key, None)
            changed = True
    return changed


def _reconcile_processed_transcript_ai_scope(
    output_directory: str | None,
    expected_keys: set[str],
) -> dict:
    if not output_directory or not expected_keys:
        return {"preservedUnmatchedCount": 0, "restoredCurrentCount": 0}

    payload = _load_processed_transcripts_payload(output_directory)
    if not payload:
        return {"preservedUnmatchedCount": 0, "restoredCurrentCount": 0}

    changed = False
    preserved_count = 0
    restored_count = 0
    preserved_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    for file_key, record in payload.items():
        if not isinstance(record, dict):
            continue
        if file_key in expected_keys:
            if _remove_preserved_transcript_metadata(record):
                restored_count += 1
                changed = True
            continue
        already_preserved = (
            record.get("manualCodingPreservedReason") == PRESERVED_TRANSCRIPT_REASON_UNMATCHED
            and record.get("skipAiTagging") is True
        )
        if not already_preserved:
            record.update(PRESERVED_TRANSCRIPT_METADATA)
            record["manualCodingPreservedAt"] = preserved_at
            preserved_count += 1
            changed = True

    if changed:
        _write_processed_transcripts_payload(output_directory, payload)
        print(
            "[INFO] Reconciled transcript-mode manual coding preservation scope before AI tagging: "
            f"preserved={preserved_count}, restored={restored_count}"
        )
    return {
        "preservedUnmatchedCount": preserved_count,
        "restoredCurrentCount": restored_count,
    }


def _process_transcripts_preserving_manual_state(
    *,
    input_directory: str | None,
    output_directory: str | None,
    file_map: dict | None,
) -> tuple[dict, dict]:
    previous_payload = _load_processed_transcripts_payload(output_directory)
    processed_data = transcriptProcessing.doc_processing(
        input_directory=input_directory,
        output_directory=output_directory,
        file_map=file_map,
    )
    if not isinstance(processed_data, dict):
        processed_data = {}

    merged_payload, preservation_stats = _merge_processed_transcripts_preserving_manual_state(
        processed_data,
        previous_payload,
    )
    if merged_payload != processed_data:
        _write_processed_transcripts_payload(output_directory, merged_payload)
        print(
            "[INFO] Preserved transcript-mode manual coding state during transcript processing: "
            f"{preservation_stats}"
        )
    return merged_payload, preservation_stats


def _ensure_processed_transcripts_cover_uploads(
    *,
    mode: str | None,
    project_id: str | None,
    input_directory: str | None,
    output_directory: str | None,
    file_map: dict | None = None,
    user_id: str | None = None,
    status_path: str | None = None,
    progress_extra: dict | None = None,
) -> dict:
    if mode == "demo" or not input_directory or not output_directory:
        return {"reprocessed": False, "missing": []}

    processing_file_map = file_map if isinstance(file_map, dict) else {"participants": []}
    expected_keys = transcriptProcessing.expected_transcript_output_keys(input_directory, processing_file_map)
    if not expected_keys:
        return {"reprocessed": False, "missing": []}

    current_keys = _processed_transcript_keys(output_directory)
    missing_keys = sorted(expected_keys - current_keys)
    scope_stats = _reconcile_processed_transcript_ai_scope(output_directory, expected_keys)
    if not missing_keys:
        return {"reprocessed": False, "missing": [], **scope_stats}

    print(
        "[INFO] Processed transcripts are missing uploaded participant file(s): "
        f"{missing_keys}. Rebuilding all_transcripts_processed.json before tagging."
    )
    if user_id:
        set_progress(
            user_id,
            0,
            f"Processing {len(missing_keys)} uploaded transcript(s)",
            extra=progress_extra,
            project_id=project_id,
            mode=mode,
            status_path=status_path,
        )

    processed_data, preservation_stats = _process_transcripts_preserving_manual_state(
        input_directory=input_directory,
        output_directory=output_directory,
        file_map=processing_file_map,
    )
    return {
        "reprocessed": True,
        "missing": missing_keys,
        "processedEntryCount": len(processed_data) if isinstance(processed_data, dict) else 0,
        **preservation_stats,
        "restoredCurrentCount": scope_stats.get("restoredCurrentCount", 0),
    }

def _count_selected_themes(theme_object) -> int:
    if not isinstance(theme_object, dict):
        return 0
    themes = theme_object.get("themes")
    if not isinstance(themes, list):
        return 0
    count = 0
    for theme in themes:
        if isinstance(theme, dict) and str(theme.get("themeName", "")).strip():
            count += 1
        elif isinstance(theme, str) and theme.strip():
            count += 1
    return count


def _resolve_mode_output_json_path() -> str:
    mode = session.get("mode", "user")
    project_id = _request_project_id(session.get("current_project_id"))
    return _output_json_path_for_mode_project(mode=mode, project_id=project_id)


def _output_json_path_for_mode_project(mode: str | None = None, project_id: str | None = None) -> str:
    resolved_mode = mode or session.get("mode", "user")
    resolved_project_id = project_id if project_id is not None else session.get("current_project_id")
    if resolved_mode == "demo":
        ensure_demo_assets()
        return get_demo_output_json_path(resolved_project_id)
    return get_user_output_json_path(resolved_project_id)


def _get_code_groups_path(project_id: str | None = None, mode: str | None = None) -> str:
    resolved_mode = mode or session.get("mode", "user")
    resolved_project_id = project_id if project_id is not None else session.get("current_project_id")
    if resolved_mode == "demo":
        return os.path.join(get_demo_project_outputs_dir(resolved_project_id), "code_groups.json")
    return os.path.join(get_user_project_processed_dir(resolved_project_id), "code_groups.json")


def _seed_empty_code_groups_for_project(project_id: str | None = None, mode: str = "user") -> str:
    groups_path = _get_code_groups_path(project_id=project_id, mode=mode)
    os.makedirs(os.path.dirname(groups_path), exist_ok=True)
    if not os.path.exists(groups_path):
        with open(groups_path, "w", encoding="utf-8") as f:
            json.dump({"groups": [], "meta": {}}, f, indent=2, ensure_ascii=False)
    return groups_path


def _normalize_theme_lookup_name(value: str | None) -> str:
    text = str(value or "").strip().replace("&", " and ")
    text = re.sub(r"[_-]+", " ", text)
    text = re.sub(r"[^A-Za-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip().lower()


def _normalize_group_path(value: str | None) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    parts = [part.strip() for part in raw.split(">")]
    parts = [part for part in parts if part]
    return " > ".join(parts)


def _find_theme_key_in_output(output_data: dict, theme_name: str | None):
    if not isinstance(output_data, dict):
        return None
    normalized_target = _normalize_theme_lookup_name(theme_name)
    for key in output_data.keys():
        if _normalize_theme_lookup_name(key) == normalized_target:
            return key
    return None


def _refresh_session_theme_object_from_output(output_path: str):
    if 'user' not in session:
        return
    try:
        if output_path and os.path.exists(output_path):
            _store_theme_object_in_session(
                build_theme_object_from_output(output_path),
                session.get("current_project_id"),
            )
    except Exception as e:
        print(f"[WARN] Could not refresh session themeObject from {output_path}: {e}")

def generate_themes_background(user_id, mode="user", project_id=None, processed_dir=None, uploads_dir=None, intermediate_dir=None, status_path: str | None = None, job_key: str | None = None, file_map: dict | None = None, input_signature: dict | None = None, workspace_key: str | None = None):
    previous_workspace_key = _set_thread_workspace_key(workspace_key)
    heartbeat_stop = None
    try:
        runtime_dirs = _resolve_project_runtime_dirs(mode, project_id)
        resolved_processed_dir = processed_dir or runtime_dirs.get("processed_dir")
        resolved_uploads_dir = uploads_dir or runtime_dirs.get("uploads_dir")
        resolved_intermediate_dir = intermediate_dir or runtime_dirs.get("intermediate_dir")
        resolved_input_signature = input_signature or _tagging_input_signature(
            mode=mode,
            project_id=project_id,
            uploads_dir=resolved_uploads_dir,
            file_map=file_map,
        )
        progress_extra = _tagging_progress_extra(resolved_input_signature)
        if job_key:
            progress_extra["jobKey"] = job_key
        heartbeat_stop = _start_tagging_progress_heartbeat(
            user_id,
            project_id,
            mode,
            status_path,
        )
        qwen_qna = _build_qna_runtime(
            mode,
            project_id,
            processed_dir=resolved_processed_dir,
            uploads_dir=resolved_uploads_dir,
            intermediate_dir=resolved_intermediate_dir,
        )
        qwen = _build_qwen_runtime(
            mode,
            project_id,
            processed_dir=resolved_processed_dir,
            intermediate_dir=resolved_intermediate_dir,
        )
        _ensure_processed_transcripts_cover_uploads(
            mode=mode,
            project_id=project_id,
            input_directory=resolved_uploads_dir,
            output_directory=resolved_processed_dir,
            file_map=file_map,
            user_id=user_id,
            status_path=status_path,
            progress_extra=progress_extra,
        )
        # -------- STEP 1 --------
        set_progress(user_id, 1, "Tagging Questions", extra=progress_extra, project_id=project_id, mode=mode, status_path=status_path)
        qwen_qna.extract_interviewer_script()
        qwen_qna.tag_questions_batch(batch_size=25)
        qwen_qna.add_tagged_questions()
        _refresh_qna_tag_conflicts_for_path(qwen_qna.TRANSCRIPTS_JSON_PATH)

        # -------- STEP 2 --------
        set_progress(user_id, 2, "Tagging Answers", extra=progress_extra, project_id=project_id, mode=mode, status_path=status_path)
        qwen_qna.extract_questions_possible_answers()
        qwen_qna.tag_answer_batch(batch_size=14)
        qwen_qna.add_tagged_answers()
        _refresh_qna_tag_conflicts_for_path(qwen_qna.TRANSCRIPTS_JSON_PATH)
        qwen.extract_answers_by_tag()

        # -------- STEP 3 --------
        set_progress(user_id, 3, "Generating Themes", extra=progress_extra, project_id=project_id, mode=mode, status_path=status_path)
        themes_path = Path(_themes_txt_path(mode=mode, project_id=project_id, processed_dir=resolved_processed_dir))
        if themes_path.is_file():
            remove_existing_themes_file(project_id=project_id, mode=mode, processed_dir=resolved_processed_dir)

        topics = qwen.qwenModel()
        themes = write_topics_qwen(topics, project_id=project_id, mode=mode, processed_dir=resolved_processed_dir)

        # -------- COMPLETE --------
        set_progress(
            user_id,
            4,
            "Complete",
            extra={"themes": themes, **progress_extra},
            project_id=project_id,
            mode=mode,
            status_path=status_path
        )
        if mode != "demo":
            _mark_tagging_run_complete(project_id, resolved_input_signature)
        with progress_lock:
            store_key = _progress_store_key(user_id, project_id=project_id, mode=mode)
            if isinstance(progress_store.get(store_key), dict):
                progress_store[store_key]["themes"] = themes


    except Exception as e:
        error_extra = _tagging_progress_extra(input_signature)
        set_progress(user_id, -1, f"Error: {str(e)}", extra=error_extra, project_id=project_id, mode=mode, status_path=status_path)

    finally:
        if heartbeat_stop:
            heartbeat_stop.set()
        _restore_thread_workspace_key(previous_workspace_key)
        with running_jobs_lock:
            running_jobs.discard(job_key or _generation_job_key(user_id, project_id=project_id, mode=mode))

DEMO_PARTICIPANTS = ["P3", "P6", "P7"]


def _public_base_url() -> str:
    return PUBLIC_BASE_URL.rstrip("/") or "http://127.0.0.1:5001"


def _request_wants_json() -> bool:
    accept_header = (request.headers.get("Accept") or "").lower()
    requested_with = (request.headers.get("X-Requested-With") or "").lower()
    return (
        "application/json" in accept_header
        or requested_with in {"fetch", "xmlhttprequest"}
        or request.is_json
    )


def _safe_redirect_target(target: str | None, fallback: str | None = None) -> str:
    fallback_target = fallback or url_for("home")
    raw_target = str(target or "").strip()
    if not raw_target:
        return fallback_target
    if raw_target.startswith("//"):
        return fallback_target

    parsed = urlparse(raw_target)
    if parsed.scheme or parsed.netloc:
        allowed_hosts = {
            str(request.host or "").lower(),
            str(urlparse(_public_base_url()).netloc or "").lower(),
        }
        if str(parsed.netloc or "").lower() not in allowed_hosts:
            return fallback_target
        path = parsed.path or "/"
        return f"{path}?{parsed.query}" if parsed.query else path

    if not raw_target.startswith("/"):
        return fallback_target
    return raw_target


def _normalize_route_path(path: str | None) -> str:
    if not path:
        return "/"
    normalized = str(path).strip()
    if not normalized:
        return "/"
    if not normalized.startswith("/"):
        normalized = f"/{normalized}"
    return normalized


def is_demo_prefixed_path(path: str | None = None) -> bool:
    resolved = _normalize_route_path(path if path is not None else (request.path if has_request_context() else "/"))
    return resolved == DEMO_ROUTE_PREFIX or resolved.startswith(f"{DEMO_ROUTE_PREFIX}/")


def demo_prefixed_path(path: str | None) -> str:
    normalized = _normalize_route_path(path)
    if is_demo_prefixed_path(normalized):
        return normalized
    if normalized == "/":
        return DEMO_ROUTE_PREFIX
    return f"{DEMO_ROUTE_PREFIX}{normalized}"


def scoped_route_path(path: str | None, force_demo: bool | None = None) -> str:
    normalized = _normalize_route_path(path)
    use_demo = force_demo
    if use_demo is None:
        use_demo = has_request_context() and (
            is_demo_prefixed_path() or (session.get(ROUTE_SCOPE_SESSION_KEY) == "demo")
        )
    return demo_prefixed_path(normalized) if use_demo else normalized


def _set_route_scope(scope: str | None):
    if not has_request_context():
        return
    if scope:
        session[ROUTE_SCOPE_SESSION_KEY] = scope
    else:
        session.pop(ROUTE_SCOPE_SESSION_KEY, None)


def _is_demo_route_scope_active() -> bool:
    return has_request_context() and session.get(ROUTE_SCOPE_SESSION_KEY) == "demo"


def _user_projects_root_dir(create: bool = True) -> str:
    return project_storage.user_projects_root(STATIC_DIR, create=create)


def _legacy_user_project_dir(project_id: str | None) -> str:
    return os.path.join(_user_projects_root_dir(create=False), _safe_project_id(project_id))


def _get_workspace_preferences() -> dict:
    path = os.path.join(_workspace_root_dir(), "preferences.json")
    preferences = _load_json_or_none(path)
    return preferences if isinstance(preferences, dict) else {}


def _set_workspace_preference(key: str, value):
    with workspace_preferences_lock:
        preferences = _get_workspace_preferences()
        preferences[key] = value
        path = os.path.join(_workspace_root_dir(), "preferences.json")
        _atomic_write_json(path, preferences)
    return value


def _current_user_workspace_key(default: str = LOCAL_WORKSPACE_KEY) -> str:
    if has_request_context():
        key = session.get("user_workspace_key")
        if isinstance(key, str) and key.strip():
            return key.strip()
    thread_key = _thread_workspace_key()
    if thread_key:
        return thread_key
    return default


def _workspace_root_dir(workspace_key: str | None = None, create: bool = True) -> str:
    safe_key = "".join(c for c in str(workspace_key or _current_user_workspace_key()) if c.isalnum() or c in ("-", "_"))
    safe_key = safe_key or "user_000_guest"
    return project_storage.workspace_root(STATIC_DIR, safe_key, create=create)


def _workspace_projects_root(workspace_key: str | None = None, create: bool = True) -> str:
    root = os.path.join(_workspace_root_dir(workspace_key, create=create), "projects")
    if create:
        os.makedirs(root, exist_ok=True)
    return root


def _workspace_projects_index_path(workspace_key: str | None = None) -> str:
    return os.path.join(_workspace_root_dir(workspace_key, create=True), "projects_index.json")


def _normalize_workspace_projects(projects) -> list[dict]:
    normalized = []
    seen = set()
    for idx, project in enumerate(projects if isinstance(projects, list) else []):
        if not isinstance(project, dict):
            continue
        project_id = _safe_project_id(project.get("projectId"))
        if not project_id or project_id in seen:
            continue
        if _is_user_demo_project_id(project_id):
            continue
        project_number = _extract_project_number(project) or idx + 1
        project_name = str(project.get("projectName") or "").strip() or f"Project {project_number}"
        normalized.append({
            "projectId": project_id,
            "projectName": project_name,
            "projectNumber": project_number,
        })
        seen.add(project_id)
    return normalized


def _load_workspace_project_index(workspace_key: str | None = None) -> dict:
    path = os.path.join(_workspace_root_dir(workspace_key, create=False), "projects_index.json")
    if not os.path.exists(path):
        return {"projects": [], "currentProjectId": None}
    try:
        with open(path, "r", encoding="utf-8") as f:
            payload = json.load(f) or {}
        if not isinstance(payload, dict):
            payload = {}
    except Exception:
        return {"projects": [], "currentProjectId": None}

    normalized_projects = _normalize_workspace_projects(payload.get("projects", []))
    valid_project_ids = {project.get("projectId") for project in normalized_projects}

    raw_current_by_session = payload.get("currentProjectBySession")
    current_by_session: dict[str, str] = {}
    if isinstance(raw_current_by_session, dict):
        for session_key, candidate_project_id in raw_current_by_session.items():
            safe_session_key = _safe_session_id(session_key)
            safe_project_id = _safe_project_id(candidate_project_id)
            if safe_project_id in valid_project_ids:
                current_by_session[safe_session_key] = safe_project_id

    session_project_id = None
    session_slot = _current_session_project_slot()
    if session_slot:
        session_project_id = current_by_session.get(session_slot)

    current_project_id = str(session_project_id or payload.get("currentProjectId") or "").strip()
    if current_project_id:
        current_project_id = _safe_project_id(current_project_id)
    if current_project_id not in valid_project_ids:
        current_project_id = None

    return {
        "projects": normalized_projects,
        "currentProjectId": current_project_id,
        "currentProjectBySession": current_by_session,
        "updated_at": payload.get("updated_at"),
    }


def _load_workspace_projects(workspace_key: str | None = None) -> list[dict]:
    return _load_workspace_project_index(workspace_key).get("projects", [])


def _persist_workspace_projects(
    projects: list[dict] | None = None,
    workspace_key: str | None = None,
    current_project_id: str | None = None,
):
    if projects is None and has_request_context():
        projects = session.get("user_projects", [])
    normalized_projects = _normalize_workspace_projects(projects or [])

    existing_index = _load_workspace_project_index(workspace_key)
    if current_project_id is None:
        current_project_id = existing_index.get("currentProjectId")
    current_project_id = _safe_project_id(current_project_id) if current_project_id else None

    valid_project_ids = {project.get("projectId") for project in normalized_projects}
    if current_project_id not in valid_project_ids:
        current_project_id = normalized_projects[0].get("projectId") if normalized_projects else None

    current_by_session = {
        _safe_session_id(session_key): _safe_project_id(project_id)
        for session_key, project_id in (existing_index.get("currentProjectBySession") or {}).items()
        if _safe_project_id(project_id) in valid_project_ids
    }
    session_slot = _current_session_project_slot()
    if session_slot and current_project_id:
        current_by_session[session_slot] = current_project_id

    path = _workspace_projects_index_path(workspace_key)
    payload = {
        "projects": normalized_projects,
        "updated_at": int(time.time()),
    }
    if current_project_id:
        payload["currentProjectId"] = current_project_id
    if current_by_session:
        payload["currentProjectBySession"] = current_by_session
    try:
        _atomic_write_json(path, payload)
    except Exception as e:
        print(f"[WARN] Could not persist projects index at {path}: {e}")


def _is_legacy_project_id(project_id: str) -> bool:
    if project_id.startswith("user_project_"):
        return True
    return re.fullmatch(r"project_[0-9a-f]{8}", project_id or "") is not None


def _extract_project_number(project: dict) -> int:
    if not isinstance(project, dict):
        return 0
    explicit_number = project.get("projectNumber") or project.get("project_number")
    try:
        explicit_number = int(explicit_number)
    except (TypeError, ValueError):
        explicit_number = 0
    if explicit_number > 0:
        return explicit_number

    project_id = _safe_project_id(project.get("projectId"))
    id_match = re.fullmatch(r"(?:demo_)?(?:user_)?project_(\d+)", project_id)
    if id_match:
        return int(id_match.group(1))
    name = str(project.get("projectName") or "").strip()
    name_match = re.fullmatch(r"project\s+(\d+)", name, flags=re.IGNORECASE)
    if name_match:
        return int(name_match.group(1))
    return 0


def _session_has_project_activity(project_id: str) -> bool:
    safe_project_id = "".join(c for c in (project_id or "") if c.isalnum() or c in ("-", "_"))
    if not safe_project_id:
        return False

    session_id = session.get("session_id")
    if session_id:
        project_base_dir = get_user_project_base_dir(safe_project_id)
        session_data_dir = os.path.join(project_base_dir, "session_data", "".join(c for c in session_id if c.isalnum() or c in ("-", "_")))
        project_filemap = os.path.join(session_data_dir, "filemap.json")
        if os.path.exists(project_filemap):
            return True
        if "SESSION_DATA_DIR" in globals():
            legacy_filemap = os.path.join(SESSION_DATA_DIR, session_id, f"filemap_{safe_project_id}.json")
            if os.path.exists(legacy_filemap):
                return True

    if "STATIC_DIR" in globals():
        workspace_key = session.get("user_workspace_key")
        workspace_project_dir = os.path.join(_workspace_projects_root(workspace_key, create=False), safe_project_id)
        if os.path.isdir(workspace_project_dir):
            try:
                if any(os.scandir(workspace_project_dir)):
                    return True
            except OSError:
                pass

    return False


def ensure_user_session_context():
    initialize_local_session(session)
    session.permanent = True
    now = int(time.time())
    if 'session_created_at' not in session:
        session['session_created_at'] = now
    session['session_last_seen_at'] = now
    if 'user_id' not in session:
        session['user_id'] = LOCAL_WORKSPACE_KEY
    if 'session_id' not in session:
        session['session_id'] = str(uuid.uuid4())
    previous_project_id = session.get("current_project_id")
    previous_mode = session.get("mode", "user")

    # Page loads only read the shared index. Project actions save changes explicitly,
    # so an older browser request cannot overwrite a newer project list.
    workspace_index = _load_workspace_project_index(session.get("user_workspace_key"))
    raw_projects = []
    seen_project_ids = set()

    # Other browsers may have renamed or deleted a project since this cookie was
    # saved. Restore from disk so stale session data cannot bring it back.
    for project in workspace_index.get("projects", []):
        if not isinstance(project, dict):
            continue
        project_id = _safe_project_id(project.get("projectId"))
        if not project_id or project_id in seen_project_ids:
            continue
        raw_projects.append(project)
        seen_project_ids.add(project_id)

    normalized_projects = []
    seen_project_ids.clear()
    for idx, project in enumerate(raw_projects):
        if not isinstance(project, dict):
            continue
        raw_project_id = project.get("projectId")
        project_id = "".join(c for c in str(raw_project_id or "") if c.isalnum() or c in ("-", "_"))
        if not project_id or project_id in seen_project_ids:
            continue
        if _is_user_demo_project_id(project_id):
            continue
        project_number = _extract_project_number(project) or idx + 1
        project_name = (project.get("projectName") or "").strip() or f"Project {project_number}"
        normalized_projects.append({
            "projectId": project_id,
            "projectName": project_name,
            "projectNumber": project_number,
        })
        seen_project_ids.add(project_id)

    if not normalized_projects:
        normalized_projects = []

    legacy_defaults = [
        {"projectId": "user_project_1", "projectName": "Project 1", "projectNumber": 1},
        {"projectId": "user_project_2", "projectName": "Project 2", "projectNumber": 2},
        {"projectId": "user_project_3", "projectName": "Project 3", "projectNumber": 3},
    ]
    new_defaults = [
        {"projectId": "project_1", "projectName": "Project 1", "projectNumber": 1},
        {"projectId": "project_2", "projectName": "Project 2", "projectNumber": 2},
        {"projectId": "project_3", "projectName": "Project 3", "projectNumber": 3},
    ]
    if normalized_projects == legacy_defaults or normalized_projects == new_defaults:
        has_extra_data = any(
            _session_has_project_activity(pid)
            for pid in ("user_project_2", "user_project_3", "project_2", "project_3")
        )
        if not has_extra_data:
            normalized_projects = [normalized_projects[0]]

    session['user_projects'] = normalized_projects

    if session.get("mode") == "demo":
        _set_route_scope("demo")
        if (not session.get("current_project_id")) or (not get_demo_project_dir(session.get("current_project_id"))):
            session['current_project_id'] = DEFAULT_DEMO_PROJECT_ID
            session['current_project_name'] = DEMO_PROJECT_DEFS[0].get("project_name", "Project 1")
        return

    project_ids = {project.get("projectId") for project in session.get("user_projects", [])}
    if not project_ids:
        _clear_project_scoped_session_cache_if_changed(
            previous_project_id,
            previous_mode,
            None,
            "user",
        )
        session.pop('current_project_id', None)
        session.pop('current_project_name', None)
        session['mode'] = 'user'
        _set_route_scope("user")
        session['is_new_project'] = False
        return

    if ('current_project_id' not in session) or (session.get("current_project_id") not in project_ids):
        shared_project_id = workspace_index.get("currentProjectId")
        if shared_project_id in project_ids:
            session['current_project_id'] = shared_project_id
        else:
            first_project = session['user_projects'][0]
            session['current_project_id'] = first_project.get("projectId", "project_1")
    else:
        shared_project_id = workspace_index.get("currentProjectId")
        if shared_project_id in project_ids:
            session['current_project_id'] = shared_project_id

    active_name = None
    for project in session.get("user_projects", []):
        if project.get("projectId") == session.get("current_project_id"):
            active_name = project.get("projectName")
            break
    _clear_project_scoped_session_cache_if_changed(
        previous_project_id,
        previous_mode,
        session.get("current_project_id"),
        session.get("mode", "user"),
    )
    session['current_project_name'] = active_name or session.get('current_project_name') or "Project 1"


def set_current_project(project_id: str, project_name: str | None = None, mode: str | None = None):
    previous_project_id = session.get("current_project_id")
    previous_mode = session.get("mode", "user")
    session['current_project_id'] = project_id
    if project_name:
        session['current_project_name'] = project_name
    if mode:
        session['mode'] = mode
        if mode == "demo":
            _set_route_scope("demo")
        elif mode == "user":
            _set_route_scope("user")
    resolved_mode = mode or session.get("mode", "user")
    _clear_project_scoped_session_cache_if_changed(
        previous_project_id,
        previous_mode,
        project_id,
        resolved_mode,
    )
    if resolved_mode == "user" and has_request_context():
        _persist_workspace_projects(
            session.get("user_projects", []),
            session.get("user_workspace_key"),
            current_project_id=project_id,
        )


def start_new_project(project_name: str | None = None):
    ensure_user_session_context()
    user_projects = session.get("user_projects", [])
    if not isinstance(user_projects, list):
        user_projects = []

    next_number = 1
    for project in user_projects:
        next_number = max(next_number, _extract_project_number(project) + 1)

    existing_ids = {
        project.get("projectId")
        for project in user_projects
        if isinstance(project, dict) and project.get("projectId")
    }
    while f"project_{next_number}" in existing_ids:
        next_number += 1

    new_project_id = f"project_{next_number}"
    new_project_name = (project_name or "").strip() or f"Project {next_number}"

    user_projects.append({
        "projectId": new_project_id,
        "projectName": new_project_name,
        "projectNumber": next_number,
    })
    session["user_projects"] = user_projects
    _persist_workspace_projects(
        user_projects,
        session.get("user_workspace_key"),
        current_project_id=new_project_id,
    )

    set_current_project(new_project_id, new_project_name, "user")
    _ensure_project_storage_meta(new_project_id)
    _set_project_awaiting_first_upload(new_project_id, True)
    _seed_empty_filemap_for_project(new_project_id)
    _seed_empty_code_groups_for_project(new_project_id)
    _record_user_project_name(new_project_id, new_project_name)
    explicit_name_entered = bool(str(project_name or "").strip())
    _mark_project_workflow_step(
        new_project_id,
        "project_named" if explicit_name_entered else "project_created",
        {
            "projectName": new_project_name,
            "awaitingFirstUpload": True,
            "nextStep": "upload_files" if explicit_name_entered else "name_project",
        },
        project_name_confirmed=explicit_name_entered,
    )
    session['themeObject'] = {}
    session['is_new_project'] = True
    return new_project_id


def _safe_project_id(project_id: str | None = None) -> str:
    raw = project_id or session.get("current_project_id") or "default"
    safe = "".join(c for c in raw if c.isalnum() or c in ("-", "_"))
    return safe or "default"


def _session_project_is_authorized(project_id: str | None) -> bool:
    if not has_request_context() or not is_local_session(session):
        return False
    safe_project_id = _safe_project_id(project_id)
    if safe_project_id == _safe_project_id(session.get("current_project_id")):
        return True
    if _is_demo_seed_project_id(safe_project_id):
        return True
    authorized_ids = {
        _safe_project_id(project.get("projectId"))
        for project in session.get("user_projects", [])
        if isinstance(project, dict) and project.get("projectId")
    }
    if safe_project_id in authorized_ids:
        return True
    if _is_user_demo_project_id(safe_project_id):
        candidate_dir = os.path.join(
            _workspace_projects_root(session.get("user_workspace_key"), create=False),
            safe_project_id,
        )
        return os.path.isdir(candidate_dir)
    return False


def _project_not_found_response():
    return jsonify({"error": "Project not found."}), 404


def _is_user_demo_project_id(project_id: str | None = None) -> bool:
    safe_project_id = _safe_project_id(project_id)
    demo_prefix = globals().get("USER_DEMO_PROJECT_PREFIX", "demo_project")
    return safe_project_id == demo_prefix or safe_project_id.startswith(f"{demo_prefix}_")


def _safe_session_id(session_id: str | None = None) -> str:
    if session_id is None and has_request_context():
        session_id = session.get("session_id")
    raw = str(session_id or "default_session")
    safe = "".join(c for c in raw if c.isalnum() or c in ("-", "_"))
    return safe or "default_session"


def _project_meta_path(project_id: str | None = None) -> str:
    return os.path.join(get_user_project_base_dir(project_id), "project_meta.json")


def _project_mutation_lock(project_id: str | None = None, workspace_key: str | None = None) -> RLock:
    resolved_workspace = workspace_key or _current_user_workspace_key()
    lock_key = f"{_safe_usage_log_key(resolved_workspace)}::{_safe_project_id(project_id)}"
    with project_mutation_locks_lock:
        return project_mutation_locks.setdefault(lock_key, RLock())


def _project_revision(project_id: str | None = None) -> int:
    meta = _ensure_project_storage_meta(project_id)
    try:
        return max(0, int(meta.get("revision", 0) or 0))
    except (TypeError, ValueError):
        return 0


def _advance_project_revision(project_id: str | None = None) -> int:
    next_revision = _project_revision(project_id) + 1

    def mutator(meta: dict) -> bool:
        meta["revision"] = next_revision
        meta["revision_updated_at"] = int(time.time())
        return True

    _update_project_meta(project_id, mutator)
    return next_revision


def _project_name_for_id(project_id: str | None = None) -> str | None:
    if not has_request_context():
        return None
    if not project_id:
        return session.get("current_project_name")
    if session.get("current_project_id") == project_id:
        return session.get("current_project_name")
    for project in session.get("user_projects", []):
        if project.get("projectId") == project_id:
            return project.get("projectName")
    return None

def _is_dir_empty(path: str) -> bool:
    try:
        return not any(os.scandir(path))
    except FileNotFoundError:
        return True


def _migrate_legacy_project_dirs(base_dir: str, meta: dict) -> bool:
    migrated = False
    legacy_upload_root = os.path.join(base_dir, "Uploaded_files")
    legacy_processed = os.path.join(base_dir, "Processed_files")

    new_upload_dir = os.path.join(base_dir, meta.get("uploads_dir", "inputs"))
    new_outputs_dir = os.path.join(base_dir, meta.get("outputs_dir", "outputs"))

    if os.path.exists(legacy_processed):
        if not os.path.exists(new_outputs_dir) or _is_dir_empty(new_outputs_dir):
            os.makedirs(os.path.dirname(new_outputs_dir), exist_ok=True)
            shutil.move(legacy_processed, new_outputs_dir)
            migrated = True
        else:
            print(f"[WARN] Legacy outputs found but new outputs dir is not empty: {new_outputs_dir}")

    if os.path.exists(legacy_upload_root):
        legacy_uploads = os.path.join(legacy_upload_root, "uploads")
        legacy_audio = os.path.join(legacy_upload_root, "audio_storage")
        legacy_questions = os.path.join(legacy_upload_root, "Questions")

        os.makedirs(new_upload_dir, exist_ok=True)

        if os.path.exists(legacy_uploads):
            if _is_dir_empty(new_upload_dir):
                shutil.move(legacy_uploads, new_upload_dir)
            else:
                for entry in os.listdir(legacy_uploads):
                    shutil.move(os.path.join(legacy_uploads, entry), os.path.join(new_upload_dir, entry))
            migrated = True

        if os.path.exists(legacy_audio):
            target_audio = os.path.join(new_upload_dir, "audio_storage")
            if not os.path.exists(target_audio) or _is_dir_empty(target_audio):
                os.makedirs(os.path.dirname(target_audio), exist_ok=True)
                shutil.move(legacy_audio, target_audio)
                migrated = True
            else:
                print(f"[WARN] Legacy audio found but target audio dir is not empty: {target_audio}")

        if os.path.exists(legacy_questions):
            target_questions = os.path.join(new_upload_dir, "Questions")
            if not os.path.exists(target_questions) or _is_dir_empty(target_questions):
                os.makedirs(os.path.dirname(target_questions), exist_ok=True)
                shutil.move(legacy_questions, target_questions)
                migrated = True
            else:
                print(f"[WARN] Legacy questions found but target dir is not empty: {target_questions}")

        try:
            if _is_dir_empty(legacy_upload_root):
                os.rmdir(legacy_upload_root)
        except OSError:
            pass

    return migrated


def _migrate_legacy_session_filemaps(base_dir: str, meta: dict, project_id: str | None = None) -> bool:
    safe_project_id = _safe_project_id(project_id)
    if not safe_project_id or not os.path.isdir(SESSION_DATA_DIR):
        return False
    if (has_request_context() and session.get("user_workspace_key")) or _thread_workspace_key():
        return False

    migrated = False
    target_root = os.path.join(base_dir, meta.get("session_data_dir", "session_data"))
    os.makedirs(target_root, exist_ok=True)

    try:
        for session_entry in os.listdir(SESSION_DATA_DIR):
            legacy_session_dir = os.path.join(SESSION_DATA_DIR, session_entry)
            if not os.path.isdir(legacy_session_dir):
                continue

            legacy_filemap = os.path.join(legacy_session_dir, f"filemap_{safe_project_id}.json")
            if not os.path.exists(legacy_filemap):
                continue

            target_session_dir = os.path.join(target_root, _safe_session_id(session_entry))
            os.makedirs(target_session_dir, exist_ok=True)
            target_filemap = os.path.join(target_session_dir, "filemap.json")

            if not os.path.exists(target_filemap):
                shutil.copy2(legacy_filemap, target_filemap)
                migrated = True
    except Exception as e:
        print(f"[WARN] Could not migrate legacy session filemaps for project {safe_project_id}: {e}")

    return migrated


def _ensure_project_storage_meta(project_id: str | None = None) -> dict:
    base_dir = get_user_project_base_dir(project_id)
    meta_path = _project_meta_path(project_id)
    meta = {}
    if os.path.exists(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f) or {}
        except Exception as e:
            print(f"[WARN] Could not read project meta {meta_path}: {e}")
            meta = {}

    changed = False
    if not meta.get("uploads_dir"):
        meta["uploads_dir"] = "inputs"
        changed = True
    if not meta.get("outputs_dir"):
        meta["outputs_dir"] = "outputs"
        changed = True
    if not meta.get("session_data_dir"):
        meta["session_data_dir"] = "session_data"
        changed = True
    if not meta.get("current_status_dir"):
        meta["current_status_dir"] = "current_status"
        changed = True

    safe_project_id = _safe_project_id(project_id)
    project_number = _extract_project_number({"projectId": safe_project_id})
    if meta.get("project_id") != safe_project_id:
        meta["project_id"] = safe_project_id
        changed = True
    if project_number and meta.get("project_number") != project_number:
        meta["project_number"] = project_number
        changed = True
    project_name = _project_name_for_id(project_id)
    if project_name and meta.get("project_name") != project_name:
        meta["project_name"] = project_name
        changed = True

    if meta.get("layout_version") != 6:
        meta["layout_version"] = 6
        changed = True
    try:
        revision = max(0, int(meta.get("revision", 0) or 0))
    except (TypeError, ValueError):
        revision = 0
    if meta.get("revision") != revision:
        meta["revision"] = revision
        changed = True

    if has_request_context():
        workspace_key = session.get("user_workspace_key")
        if workspace_key and meta.get("workspace_key") != workspace_key:
            meta["workspace_key"] = workspace_key
            changed = True
        owner = session.get("user")
        if owner and meta.get("owner_username") != owner:
            meta["owner_username"] = owner
            changed = True

    migrated = False
    if not meta.get("migrated_from_legacy"):
        migrated = _migrate_legacy_project_dirs(base_dir, meta)
        if migrated:
            meta["migrated_from_legacy"] = True
            changed = True

    if meta.get("session_data_migration_version") != 1:
        _migrate_legacy_session_filemaps(base_dir, meta, project_id)
        meta["session_data_migration_version"] = 1
        changed = True

    # Ensure the local folders exist for every project.
    os.makedirs(os.path.join(base_dir, meta.get("uploads_dir", "inputs")), exist_ok=True)
    os.makedirs(os.path.join(base_dir, meta.get("outputs_dir", "outputs")), exist_ok=True)
    os.makedirs(os.path.join(base_dir, meta.get("session_data_dir", "session_data")), exist_ok=True)
    os.makedirs(os.path.join(base_dir, meta.get("current_status_dir", "current_status")), exist_ok=True)

    if changed:
        try:
            _atomic_write_json(meta_path, meta)
        except Exception as e:
            print(f"[WARN] Could not write project meta {meta_path}: {e}")

    return meta


def _update_project_meta(project_id: str | None, mutator) -> dict:
    with _project_mutation_lock(project_id):
        meta = _ensure_project_storage_meta(project_id)
        updated_meta = dict(meta or {})
        changed = bool(mutator(updated_meta))
        if changed:
            meta_path = _project_meta_path(project_id)
            try:
                _atomic_write_json(meta_path, updated_meta)
            except Exception as e:
                print(f"[WARN] Could not update project meta {meta_path}: {e}")
                return meta
        return updated_meta


def _set_project_awaiting_first_upload(project_id: str | None = None, awaiting: bool = True) -> dict:
    awaiting_flag = bool(awaiting)

    def mutator(meta: dict) -> bool:
        if meta.get("awaiting_first_upload") == awaiting_flag:
            return False
        meta["awaiting_first_upload"] = awaiting_flag
        return True

    return _update_project_meta(project_id, mutator)


def _project_awaits_first_upload(project_id: str | None = None) -> bool:
    meta_path = _project_meta_path(project_id)
    meta = {}
    if os.path.exists(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f) or {}
        except Exception as e:
            print(f"[WARN] Could not read project meta {meta_path}: {e}")
            meta = {}
    if not meta:
        meta = _ensure_project_storage_meta(project_id)
    return bool(meta.get("awaiting_first_upload"))


def _mark_project_workflow_step(
    project_id: str | None,
    step: str,
    details: dict | None = None,
    project_name_confirmed: bool | None = None,
) -> dict:
    clean_step = str(step or "").strip() or "project_updated"
    clean_details = details if isinstance(details, dict) else {}
    now = int(time.time())

    def mutator(meta: dict) -> bool:
        before = json.dumps(meta, sort_keys=True, default=str)
        workflow = meta.get("workflow_state")
        if not isinstance(workflow, dict):
            workflow = {}
        steps = workflow.get("steps")
        if not isinstance(steps, dict):
            steps = {}
        step_record = steps.get(clean_step)
        if not isinstance(step_record, dict):
            step_record = {}

        step_record.update({
            "step": clean_step,
            "updated_at": now,
            **clean_details,
        })
        if has_request_context():
            step_record["session_id"] = session.get("session_id")
            workflow["last_session_id"] = session.get("session_id")
        steps[clean_step] = step_record
        workflow.update({
            "current_step": clean_step,
            "last_step": clean_step,
            "last_updated_at": now,
            "steps": steps,
        })
        meta["workflow_state"] = workflow
        if project_name_confirmed is not None:
            meta["project_name_confirmed"] = bool(project_name_confirmed)
            if project_name_confirmed and not meta.get("project_name_confirmed_at"):
                meta["project_name_confirmed_at"] = now
        if has_request_context():
            meta["last_session_id"] = session.get("session_id")
        after = json.dumps(meta, sort_keys=True, default=str)
        return before != after

    return _update_project_meta(project_id, mutator)


def _project_workflow_state(project_id: str | None = None) -> dict:
    if not project_id:
        return {}
    meta = _ensure_project_storage_meta(project_id)
    workflow = meta.get("workflow_state")
    if not isinstance(workflow, dict):
        workflow = {}
    project_name = str(meta.get("project_name") or "").strip()
    inferred_name_confirmed = bool(
        project_name
        and project_name.lower() != "untitled project"
        and re.fullmatch(r"project\s+\d+", project_name, flags=re.IGNORECASE) is None
    )
    name_confirmed = bool(meta.get("project_name_confirmed") or inferred_name_confirmed)
    return {
        "currentStep": workflow.get("current_step"),
        "lastStep": workflow.get("last_step"),
        "lastUpdatedAt": workflow.get("last_updated_at"),
        "lastSessionId": workflow.get("last_session_id") or meta.get("last_session_id"),
        "projectNameConfirmed": name_confirmed,
        "projectNameConfirmedAt": meta.get("project_name_confirmed_at"),
        "awaitingFirstUpload": bool(meta.get("awaiting_first_upload")),
        "taggingRunStatus": meta.get("tagging_run_status"),
        "taggingStartedAt": meta.get("tagging_started_at"),
        "taggingCompletedAt": meta.get("tagging_completed_at"),
        "taggingJobKey": meta.get("tagging_job_key"),
    }


def _normalize_project_name(project_name: str | None) -> str:
    if project_name is None:
        return ""
    collapsed = " ".join(str(project_name).split())
    return collapsed.casefold()


def _find_project_name_conflict(project_name: str | None, exclude_project_id: str | None = None):
    normalized_target = _normalize_project_name(project_name)
    if not normalized_target:
        return None

    safe_exclude_project_id = _safe_project_id(exclude_project_id) if exclude_project_id else None
    for project in session.get("user_projects", []):
        if not isinstance(project, dict):
            continue
        candidate_project_id = _safe_project_id(project.get("projectId"))
        if safe_exclude_project_id and candidate_project_id == safe_exclude_project_id:
            continue
        if _normalize_project_name(project.get("projectName")) == normalized_target:
            return project
    return None


def _record_user_project_name(project_id: str | None, project_name: str | None) -> dict | None:
    if not has_request_context():
        return None

    raw_project_id = project_id or session.get("current_project_id")
    if not raw_project_id:
        return None

    safe_project_id = _safe_project_id(raw_project_id)
    clean_project_name = str(project_name or "").strip() or "Untitled Project"
    project_number = _extract_project_number({
        "projectId": safe_project_id,
        "projectName": clean_project_name,
    })
    projects = session.get("user_projects", [])
    if not isinstance(projects, list):
        projects = []

    project_record = None
    for project in projects:
        if not isinstance(project, dict):
            continue
        if _safe_project_id(project.get("projectId")) == safe_project_id:
            project_record = project
            break

    if project_record is None:
        project_record = {
            "projectId": safe_project_id,
            "projectName": clean_project_name,
            "projectNumber": project_number,
        }
        projects.append(project_record)
    else:
        project_record["projectId"] = safe_project_id
        project_record["projectName"] = clean_project_name
        project_record["projectNumber"] = project_number

    session["user_projects"] = projects
    if _safe_project_id(session.get("current_project_id")) == safe_project_id:
        session["current_project_name"] = clean_project_name

    # Demo copies keep their own metadata and are excluded from the regular index.
    if not _is_user_demo_project_id(safe_project_id):
        _persist_workspace_projects(
            projects,
            session.get("user_workspace_key"),
            current_project_id=session.get("current_project_id") or safe_project_id,
        )

    def mutator(meta: dict) -> bool:
        changed = False
        if meta.get("project_id") != safe_project_id:
            meta["project_id"] = safe_project_id
            changed = True
        if meta.get("project_number") != project_number:
            meta["project_number"] = project_number
            changed = True
        if meta.get("project_name") != clean_project_name:
            meta["project_name"] = clean_project_name
            changed = True
        return changed

    meta = _update_project_meta(safe_project_id, mutator)
    return meta


def _current_user_project_requires_upload_notice(project_id: str | None = None) -> bool:
    if not has_request_context():
        return False
    if session.get("mode", "user") == "demo":
        return False
    resolved_project_id = _safe_project_id(project_id or session.get("current_project_id"))
    return _project_awaits_first_upload(resolved_project_id)


def _render_upload_required_page(active_tab: str, active_icon: str):
    session["themeObject"] = {}
    return render_template(
        "projectUploadReminder.html",
        mode=session.get("mode", "user"),
        active_tab=active_tab,
        active_icon=active_icon,
        reminder_title="Upload file in File Manager first to continue",
        reminder_message="This project does not have any uploaded files yet. Upload transcripts or audio in File Manager before using this page.",
        cta_href=url_for("fileManager"),
        cta_label="Open File Manager",
    )


def get_user_project_base_dir(project_id: str | None = None) -> str:
    if has_request_context() and ("user" in session) and (not session.get("user_workspace_key")):
        ensure_user_session_context()

    safe_project_id = _safe_project_id(project_id)
    legacy_dir = _legacy_user_project_dir(safe_project_id)
    workspace_key = session.get("user_workspace_key") if has_request_context() else _thread_workspace_key()

    if not workspace_key:
        os.makedirs(legacy_dir, exist_ok=True)
        return legacy_dir

    workspace_project_dir = os.path.join(_workspace_projects_root(workspace_key, create=True), safe_project_id)
    os.makedirs(workspace_project_dir, exist_ok=True)
    return workspace_project_dir


def _candidate_user_project_dirs(project_id: str | None = None) -> list[str]:
    safe_project_id = _safe_project_id(project_id)
    candidate_dirs: list[str] = []

    workspace_key = session.get("user_workspace_key") if has_request_context() else _thread_workspace_key()
    if workspace_key:
        workspace_project_dir = os.path.join(_workspace_projects_root(workspace_key, create=False), safe_project_id)
        candidate_dirs.append(workspace_project_dir)
    else:
        candidate_dirs.append(_legacy_user_project_dir(safe_project_id))

    unique_dirs = []
    seen = set()
    for path in candidate_dirs:
        normalized = os.path.normpath(path)
        if normalized in seen:
            continue
        seen.add(normalized)
        unique_dirs.append(path)
    return unique_dirs


def delete_user_project_storage(project_id: str | None = None) -> list[str]:
    removed_paths: list[str] = []
    for path in _candidate_user_project_dirs(project_id):
        if not os.path.exists(path):
            continue
        try:
            shutil.rmtree(path)
            removed_paths.append(path)
        except Exception as e:
            print(f"[WARN] Could not delete project storage {path}: {e}")
    return removed_paths


def get_user_project_processed_dir(project_id: str | None = None) -> str:
    meta = _ensure_project_storage_meta(project_id)
    processed_dir = os.path.join(get_user_project_base_dir(project_id), meta.get("outputs_dir", "outputs"))
    os.makedirs(processed_dir, exist_ok=True)
    return processed_dir


def get_user_project_uploads_dir(project_id: str | None = None) -> str:
    meta = _ensure_project_storage_meta(project_id)
    uploads_dir = os.path.join(get_user_project_base_dir(project_id), meta.get("uploads_dir", "inputs"))
    os.makedirs(uploads_dir, exist_ok=True)
    return uploads_dir


def get_user_project_audio_dir(project_id: str | None = None) -> str:
    audio_dir = os.path.join(get_user_project_uploads_dir(project_id), "audio_storage")
    os.makedirs(audio_dir, exist_ok=True)
    return audio_dir


def get_user_project_intermediate_dir(project_id: str | None = None) -> str:
    meta = _ensure_project_storage_meta(project_id)
    intermediate_dir = os.path.join(get_user_project_base_dir(project_id), meta.get("intermediate_dir", "intermediate_files"))
    os.makedirs(intermediate_dir, exist_ok=True)
    return intermediate_dir


def get_user_project_questions_text_dir(project_id: str | None = None) -> str:
    questions_dir = os.path.join(get_user_project_uploads_dir(project_id), "Questions")
    os.makedirs(questions_dir, exist_ok=True)
    return questions_dir


def _resolve_demo_storage_project_dir(project_id: str | None = None) -> tuple[str, str | None]:
    candidate_project_id = project_id
    if not candidate_project_id and has_request_context():
        candidate_project_id = session.get("current_project_id")
    candidate_project_id = candidate_project_id or DEFAULT_DEMO_PROJECT_ID
    project_dir = get_demo_project_dir(candidate_project_id)
    if not project_dir:
        candidate_project_id = DEFAULT_DEMO_PROJECT_ID
        project_dir = get_demo_project_dir(candidate_project_id)
    return candidate_project_id, project_dir


def get_demo_project_uploads_dir(project_id: str | None = None) -> str:
    _, project_dir = _resolve_demo_storage_project_dir(project_id)
    if project_dir:
        uploads_dir = os.path.join(project_dir, "uploads", "transcripts")
        os.makedirs(uploads_dir, exist_ok=True)
        return uploads_dir
    if has_request_context() and session.get("user"):
        return get_user_project_uploads_dir(_user_demo_project_id(project_id))
    os.makedirs(DEMO_RUNTIME_TRANSCRIPTS_DIR, exist_ok=True)
    return DEMO_RUNTIME_TRANSCRIPTS_DIR


def get_demo_project_audio_dir(project_id: str | None = None) -> str:
    _, project_dir = _resolve_demo_storage_project_dir(project_id)
    if project_dir:
        audio_dir = os.path.join(project_dir, "uploads", "audio")
        os.makedirs(audio_dir, exist_ok=True)
        return audio_dir
    if has_request_context() and session.get("user"):
        return get_user_project_audio_dir(_user_demo_project_id(project_id))
    os.makedirs(DEMO_RUNTIME_AUDIO_DIR, exist_ok=True)
    return DEMO_RUNTIME_AUDIO_DIR


def get_demo_project_questions_text_dir(project_id: str | None = None) -> str:
    _, project_dir = _resolve_demo_storage_project_dir(project_id)
    if project_dir:
        questions_dir = os.path.join(project_dir, "uploads", "Questions")
        os.makedirs(questions_dir, exist_ok=True)
        return questions_dir
    if has_request_context() and session.get("user"):
        return get_user_project_questions_text_dir(_user_demo_project_id(project_id))
    os.makedirs(DEMO_RUNTIME_QUESTIONS_DIR, exist_ok=True)
    return DEMO_RUNTIME_QUESTIONS_DIR


def get_demo_project_outputs_dir(project_id: str | None = None) -> str:
    _, project_dir = _resolve_demo_storage_project_dir(project_id)
    if project_dir:
        outputs_dir = os.path.join(project_dir, "outputs")
        os.makedirs(outputs_dir, exist_ok=True)
        return outputs_dir
    if has_request_context() and session.get("user"):
        return get_user_project_processed_dir(_user_demo_project_id(project_id))
    os.makedirs(DEMO_ASSETS_DIR, exist_ok=True)
    return DEMO_ASSETS_DIR


def get_transcript_storage_dir_for_mode(mode: str | None = None, project_id: str | None = None) -> str:
    resolved_mode = mode or (session.get("mode", "user") if has_request_context() else "user")
    if resolved_mode == "demo":
        return get_demo_project_uploads_dir(project_id)
    return get_user_project_uploads_dir(project_id)


def get_audio_storage_dir_for_mode(mode: str | None = None, project_id: str | None = None) -> str:
    resolved_mode = mode or (session.get("mode", "user") if has_request_context() else "user")
    if resolved_mode == "demo":
        return get_demo_project_audio_dir(project_id)
    return get_user_project_audio_dir(project_id)


def get_questions_text_dir_for_mode(mode: str | None = None, project_id: str | None = None) -> str:
    resolved_mode = mode or (session.get("mode", "user") if has_request_context() else "user")
    if resolved_mode == "demo":
        return get_demo_project_questions_text_dir(project_id)
    return get_user_project_questions_text_dir(project_id)


def get_user_project_session_data_root(project_id: str | None = None, create: bool = True) -> str:
    meta = _ensure_project_storage_meta(project_id)
    session_root = os.path.join(get_user_project_base_dir(project_id), meta.get("session_data_dir", "session_data"))
    if create:
        os.makedirs(session_root, exist_ok=True)
    return session_root


def get_user_project_session_data_dir(project_id: str | None = None, session_id: str | None = None, create: bool = True) -> str:
    session_root = get_user_project_session_data_root(project_id, create=create)
    safe_session = _safe_session_id(session_id)
    session_dir = os.path.join(session_root, safe_session)
    if create:
        os.makedirs(session_dir, exist_ok=True)
    return session_dir


def get_user_project_current_status_dir(project_id: str | None = None) -> str:
    meta = _ensure_project_storage_meta(project_id)
    status_dir = os.path.join(get_user_project_base_dir(project_id), meta.get("current_status_dir", "current_status"))
    os.makedirs(status_dir, exist_ok=True)
    return status_dir


def get_user_project_status_path(project_id: str | None = None) -> str:
    return os.path.join(get_user_project_current_status_dir(project_id), "progress.json")


def _resolve_status_path_for_mode(mode: str | None = None, project_id: str | None = None) -> str | None:
    resolved_mode = mode
    if resolved_mode is None:
        resolved_mode = session.get("mode", "user") if has_request_context() else "user"
    if resolved_mode == "demo":
        try:
            return get_user_project_status_path(_user_demo_project_id(project_id))
        except Exception:
            return None
    try:
        return get_user_project_status_path(project_id)
    except Exception:
        return None


def _count_files_recursive(root_dir: str) -> int:
    count = 0
    if not root_dir or not os.path.isdir(root_dir):
        return 0
    for _, _, files in os.walk(root_dir):
        count += len(files)
    return count


def _normalize_progress_payload(progress_state: dict | None, output_ready: bool = False) -> dict:
    payload = progress_state if isinstance(progress_state, dict) else {}
    try:
        stage = int(payload.get("stage", 0))
    except Exception:
        stage = 0

    message = str(payload.get("message") or "").strip()
    if output_ready and stage < 4:
        stage = 4
        if not message or message.lower() in {"idle", "not started", "started"}:
            message = "Complete"
    if not message:
        message = "Complete" if stage >= 4 else "Idle"

    running = stage in (0, 1, 2, 3) and message.lower() not in {"idle", "not started", "complete"}
    themes_ready = output_ready or bool(payload.get("themes")) or stage >= 4

    normalized = {
        "stage": stage,
        "message": message,
        "running": running,
        "themesReady": themes_ready,
    }
    updated_at = payload.get("updated_at")
    if updated_at:
        normalized["updated_at"] = updated_at
    return normalized


def _project_theme_generation_running(mode: str | None = None, project_id: str | None = None) -> bool:
    if not has_request_context():
        return False
    user_id = session.get("user_id")
    if not user_id:
        return False
    resolved_mode = mode or session.get("mode", "user")
    resolved_project_id = project_id or session.get("current_project_id")
    status_path = _resolve_status_path_for_mode(resolved_mode, resolved_project_id)
    progress_state = get_progress_for_user(
        user_id,
        project_id=resolved_project_id,
        mode=resolved_mode,
        status_path=status_path,
    )
    return bool(_normalize_progress_payload(progress_state, output_ready=False).get("running"))


def set_project_env():
    if session.get("mode") == "demo":
        return
    os.environ["CHROMA_PROCESSED_DIR"] = get_user_project_processed_dir()
    os.environ["CHROMA_UPLOADED_DIR"] = get_user_project_uploads_dir()
    os.environ["CHROMA_INTERMEDIATE_DIR"] = get_user_project_intermediate_dir()


def get_user_output_json_path(project_id: str | None = None) -> str:
    return os.path.join(get_user_project_processed_dir(project_id), "ai_generated.json")


def get_user_selected_themes_path(project_id: str | None = None) -> str:
    return os.path.join(get_user_project_processed_dir(project_id), "SelectedThemes.json")


def get_user_questions_json_path(project_id: str | None = None) -> str:
    return os.path.join(get_user_project_processed_dir(project_id), "questions.json")


def get_user_processed_transcripts_path(project_id: str | None = None) -> str:
    return os.path.join(get_user_project_processed_dir(project_id), "all_transcripts_processed.json")


def get_user_tag_conflicts_path(project_id: str | None = None) -> str:
    return os.path.join(get_user_project_processed_dir(project_id), "TagConflicts.json")


def get_demo_output_json_path(project_id: str | None = None) -> str:
    return os.path.join(get_demo_project_outputs_dir(project_id), "ai_generated.json")


def get_demo_questions_json_path(project_id: str | None = None) -> str:
    return os.path.join(get_demo_project_outputs_dir(project_id), "questions.json")


def get_demo_processed_transcripts_path(project_id: str | None = None) -> str:
    return os.path.join(get_demo_project_outputs_dir(project_id), "all_transcripts_processed.json")


def get_demo_tag_conflicts_path(project_id: str | None = None) -> str:
    return os.path.join(get_demo_project_outputs_dir(project_id), "TagConflicts.json")


def get_demo_notes_path(project_id: str | None = None) -> str:
    return os.path.join(get_demo_project_outputs_dir(project_id), "notes.json")


def get_demo_demographics_path(project_id: str | None = None) -> str:
    return os.path.join(get_demo_project_outputs_dir(project_id), "demographics", "DEMOGRAPHICS.json")


def get_user_demographics_path(project_id: str | None = None) -> str:
    return os.path.join(get_user_project_processed_dir(project_id), "demographics", "DEMOGRAPHICS.json")


def get_project_context():
    current_project_id = session.get("current_project_id")
    mode = session.get("mode", "user")
    project_progress = (
        _project_workflow_state(current_project_id)
        if current_project_id and mode != "demo"
        else {}
    )
    current_project_number = _extract_project_number({
        "projectId": current_project_id,
        "projectName": session.get("current_project_name"),
    })
    return {
        "userId": session.get("user_id"),
        "sessionId": session.get("session_id"),
        "workspaceKey": session.get("user_workspace_key"),
        "userKey": session.get("user_key"),
        "currentProjectId": current_project_id,
        "currentProjectName": session.get("current_project_name"),
        "currentProjectNumber": current_project_number,
        "mode": mode,
        "routeScope": session.get(ROUTE_SCOPE_SESSION_KEY, "user"),
        "routePrefix": DEMO_ROUTE_PREFIX if _is_demo_route_scope_active() else "",
        "projectProgress": project_progress,
        "projectNameConfirmed": bool(project_progress.get("projectNameConfirmed")),
    }


def _static_relpath(abs_path: str) -> str:
    rel_path = os.path.relpath(abs_path, STATIC_DIR)
    return rel_path.replace("\\", "/")


def _has_theme_payload(payload) -> bool:
    return (
        isinstance(payload, dict)
        and isinstance(payload.get("themes"), list)
        and len(payload.get("themes")) > 0
    )


def _has_archived_code_payload(payload) -> bool:
    return (
        isinstance(payload, dict)
        and isinstance(payload.get("archivedCodes"), list)
        and len(payload.get("archivedCodes")) > 0
    )


def _has_selected_theme_state(payload) -> bool:
    return _has_theme_payload(payload) or _has_archived_code_payload(payload)


def _user_project_has_generated_theme_data(project_id: str | None = None) -> bool:
    output_path = get_user_output_json_path(project_id)
    if _json_file_has_content(output_path):
        return True

    selected_themes_path = get_user_selected_themes_path(project_id)
    return _json_file_has_content(selected_themes_path)


def _load_user_project_theme_object(project_id: str | None = None, use_session: bool = True, display_for_visualization: bool = False):
    output_path = get_user_output_json_path(project_id)
    output_data = _load_output_theme_data(output_path)
    quote_lookup = _build_output_quote_lookup(output_data) if output_data is not None else {}
    theme_metadata = _build_output_theme_metadata(output_data) if output_data is not None else {}

    if use_session and has_request_context():
        session_theme_object = session.get("themeObject", {}) or {}
        if _has_theme_payload(session_theme_object) and not _session_theme_object_is_summary(session_theme_object):
            theme_object = _enrich_theme_payload_with_output_lookup(session_theme_object, quote_lookup, theme_metadata)
            return _filter_theme_payload_for_visualization_display(theme_object) if display_for_visualization else theme_object

    output_dir = get_user_project_processed_dir(project_id)
    selected_theme_payload = _load_selected_theme_payload(output_dir)
    if _json_file_has_content(output_path):
        generated_payload = build_theme_object_from_output(output_path, prefer_selected=False)
        if _has_selected_theme_state(selected_theme_payload):
            selected_with_generated_quotes = _merge_generated_quotes_into_theme_payload(selected_theme_payload, output_dir)
            if display_for_visualization:
                display_payload = _filter_theme_payload_for_visualization_display(selected_with_generated_quotes)
                if _has_theme_payload(display_payload) or _has_archived_code_payload(selected_with_generated_quotes):
                    return display_payload
                return generated_payload
            return _merge_theme_payloads_preserving_manual(
                selected_with_generated_quotes,
                generated_payload,
                include_generated_only=True,
            )
        return generated_payload

    if _has_selected_theme_state(selected_theme_payload):
        return _filter_theme_payload_for_visualization_display(selected_theme_payload) if display_for_visualization else selected_theme_payload

    if _project_theme_generation_running("user", project_id):
        return {"themes": []}

    if not _user_project_has_generated_theme_data(project_id):
        return {"themes": []}

    return {"themes": []}


def load_theme_titles_from_output_json(output_path: str):
    if not output_path or not os.path.exists(output_path):
        return []
    try:
        with open(output_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except Exception as e:
        print(f"[WARN] Failed to read ai_generated.json for themes: {e}")
        return []

    titles = []
    if isinstance(data, dict):
        titles = [key for key in data.keys() if isinstance(key, str) and key.strip()]
    elif isinstance(data, list):
        for entry in data:
            if isinstance(entry, str) and entry.strip():
                titles.append(entry)
                continue
            if isinstance(entry, dict):
                name = entry.get("themeName") or entry.get("theme") or entry.get("name")
                if isinstance(name, str) and name.strip():
                    titles.append(name)

    seen = set()
    unique_titles = []
    for title in titles:
        if title not in seen:
            seen.add(title)
            unique_titles.append(title)
    return unique_titles


def _seed_ai_generated_output_from_theme_payload(output_path: str, theme_payload: dict | None) -> bool:
    if not output_path or not _has_theme_payload(theme_payload):
        return False

    existing_output = _load_output_theme_data(output_path)
    output_data = existing_output if isinstance(existing_output, dict) else {}
    normalized_key_lookup = {
        _normalize_theme_lookup_name(theme_name): theme_name
        for theme_name in output_data.keys()
        if isinstance(theme_name, str) and theme_name.strip()
    }
    changed = False

    for theme in theme_payload.get("themes", []) or []:
        if not isinstance(theme, dict):
            continue
        theme_name = str(theme.get("themeName") or theme.get("theme") or theme.get("name") or "").strip()
        normalized_name = _normalize_theme_lookup_name(theme_name)
        if not theme_name or not normalized_name:
            continue

        output_key = normalized_key_lookup.get(normalized_name)
        output_entry = output_data.get(output_key, {}) if output_key else {}
        if not isinstance(output_entry, dict):
            output_entry = {}

        quotes = list(output_entry.get("quotes", []) or []) if isinstance(output_entry.get("quotes", []), list) else []
        seen_quote_keys = {
            _build_theme_word_identity_key(quote)
            for quote in quotes
            if _build_theme_word_identity_key(quote)
        }
        for word in theme.get("words", []) or []:
            if not isinstance(word, dict) or _theme_entry_is_manual(word):
                continue
            entry = _build_theme_word_entry(word)
            if not entry:
                continue
            identity_key = _build_theme_word_identity_key(entry)
            if identity_key and identity_key in seen_quote_keys:
                continue
            quote_payload = {
                "speaker": entry.get("speaker", ""),
                "text": entry.get("word", ""),
                "ai_generated": True,
                "value": entry.get("value", 1),
            }
            for optional_key in ("participant", "tag", "timestamp", "cueText", "segmentId", "sourceFile", "participantId", "startSeconds", "endSeconds"):
                if optional_key in entry:
                    quote_payload[optional_key] = entry.get(optional_key)
            quotes.append(quote_payload)
            if identity_key:
                seen_quote_keys.add(identity_key)
            changed = True

        if output_key is None and (quotes or str(theme.get("summary") or "").strip()):
            output_key = theme_name
            normalized_key_lookup[normalized_name] = output_key
            output_data[output_key] = output_entry
            changed = True

        if output_key is None:
            continue

        if quotes != output_entry.get("quotes"):
            output_entry["quotes"] = quotes
        for metadata_key in ("summary", "color", "comment"):
            metadata_value = str(theme.get(metadata_key) or "").strip()
            if metadata_value and not str(output_entry.get(metadata_key) or "").strip():
                output_entry[metadata_key] = metadata_value
                changed = True
        if isinstance(theme.get("groups"), list) and not isinstance(output_entry.get("groups"), list):
            output_entry["groups"] = list(theme.get("groups") or [])
            changed = True
        output_data[output_key] = output_entry

    if not changed:
        return False

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output_data, f, indent=2, ensure_ascii=False)
    return True


def _normalize_theme_quote_text_key(value) -> str:
    text = str(value or "").replace("“", '"').replace("”", '"').replace("‘", "'").replace("’", "'")
    return re.sub(r"\s+", " ", text.strip().strip('"').strip("'").strip("`")).lower()


def _normalize_theme_participant_code(raw_value) -> str:
    text = str(raw_value or "").strip()
    if not text:
        return ""
    match = re.search(r"(?:^|[^A-Za-z0-9])(?:participant\s*|p[\s_-]*)0*(\d+)(?=$|[^A-Za-z0-9])", text, flags=re.IGNORECASE)
    if match:
        return f"P{int(match.group(1))}"
    return ""


def _normalize_theme_qa_tag(raw_value) -> str:
    text = str(raw_value or "").strip()
    if not text:
        return ""
    match = re.search(r"\b([QA])\s*0*(\d+)([A-Za-z]?)\b", text, flags=re.IGNORECASE)
    if match:
        return f"{match.group(1).upper()}{int(match.group(2))}{match.group(3).lower()}"
    return ""


def _normalize_theme_timestamp(raw_value) -> str:
    return re.sub(r"\s+", "", str(raw_value or "").strip())


def _output_theme_entries(output_data):
    if isinstance(output_data, dict):
        for title, theme_data in output_data.items():
            if isinstance(title, str) and title.strip():
                yield title.strip(), theme_data if isinstance(theme_data, dict) else {}
        return

    if isinstance(output_data, list):
        for entry in output_data:
            if not isinstance(entry, dict):
                continue
            title = entry.get("title") or entry.get("themeName") or entry.get("theme") or entry.get("name")
            if isinstance(title, str) and title.strip():
                yield title.strip(), entry


def _build_theme_word_entry(raw_entry, fallback_entry: dict | None = None) -> dict | None:
    if isinstance(raw_entry, str):
        text = raw_entry
        value = 1
        stemmed_words = []
        speaker = ""
        participant = ""
        tag = ""
        timestamp = ""
        cue_text = ""
    elif isinstance(raw_entry, dict):
        text = raw_entry.get("word") or raw_entry.get("text") or raw_entry.get("quote") or raw_entry.get("excerpt") or ""
        value = raw_entry.get("value", 1)
        stemmed_words = raw_entry.get("stemmedWords", [])
        speaker = str(raw_entry.get("speaker") or "").strip()
        source_file = (
            raw_entry.get("source_file")
            or raw_entry.get("sourceFile")
            or raw_entry.get("file_key")
            or raw_entry.get("fileKey")
            or raw_entry.get("filename")
            or raw_entry.get("fileName")
            or raw_entry.get("relativePath")
            or raw_entry.get("transcriptFile")
            or ""
        )
        participant = (
            normalize_participant_id(raw_entry.get("participantId") or raw_entry.get("participant"))
            or _normalize_theme_participant_code(speaker)
            or _normalize_theme_participant_code(source_file)
        )
        tag = _normalize_theme_qa_tag(raw_entry.get("tag") or speaker)
        timestamp = _normalize_theme_timestamp(raw_entry.get("timestamp"))
        cue_text = str(raw_entry.get("cueText") or "").strip().strip('"').strip("'")
    else:
        return None

    text = str(text or "").strip().strip('"').strip("'")
    if not text:
        return None

    fallback = fallback_entry if isinstance(fallback_entry, dict) else {}
    fallback_speaker = str(fallback.get("speaker") or "").strip()
    fallback_source_file = (
        fallback.get("source_file")
        or fallback.get("sourceFile")
        or fallback.get("file_key")
        or fallback.get("fileKey")
        or fallback.get("filename")
        or fallback.get("fileName")
        or fallback.get("relativePath")
        or fallback.get("transcriptFile")
        or ""
    )
    fallback_participant = (
        normalize_participant_id(fallback.get("participantId") or fallback.get("participant"))
        or _normalize_theme_participant_code(fallback_speaker)
        or _normalize_theme_participant_code(fallback_source_file)
    )
    fallback_tag = _normalize_theme_qa_tag(fallback.get("tag") or fallback_speaker)
    fallback_timestamp = _normalize_theme_timestamp(fallback.get("timestamp"))
    fallback_cue_text = str(fallback.get("cueText") or "").strip().strip('"').strip("'")

    try:
        numeric_value = float(value)
    except Exception:
        numeric_value = 1

    entry = {
        "word": text,
        "value": numeric_value,
        "stemmedWords": list(stemmed_words) if isinstance(stemmed_words, list) else [],
    }

    for metadata_key in ("segmentId", "sourceFile", "participantId", "startSeconds", "endSeconds", "speakerLabel", "speakerRole"):
        if isinstance(raw_entry, dict) and metadata_key in raw_entry:
            entry[metadata_key] = raw_entry[metadata_key]
        elif metadata_key in fallback:
            entry[metadata_key] = fallback[metadata_key]
    if isinstance(raw_entry, dict) and not entry.get("sourceFile") and (source_file or fallback_source_file):
        entry["sourceFile"] = source_file or fallback_source_file

    resolved_speaker = speaker or fallback_speaker
    resolved_participant = participant or fallback_participant
    resolved_tag = tag or fallback_tag
    resolved_timestamp = timestamp or fallback_timestamp
    resolved_cue_text = cue_text or fallback_cue_text

    if resolved_speaker:
        entry["speaker"] = resolved_speaker
    if resolved_participant:
        entry["participant"] = resolved_participant
    if resolved_tag:
        entry["tag"] = resolved_tag
    if resolved_timestamp:
        entry["timestamp"] = resolved_timestamp
    if resolved_cue_text:
        entry["cueText"] = resolved_cue_text
    if isinstance(raw_entry, dict):
        source = str(raw_entry.get("codeSource") or raw_entry.get("source") or raw_entry.get("tagSource") or "").strip()
        if source:
            entry["codeSource"] = source
        source_key = source.lower()
        if source_key in {"manual", "human"}:
            entry["ai_generated"] = False
        elif source_key in {"ai", "llm", "cloud"}:
            entry["ai_generated"] = True
        elif "ai_generated" in raw_entry:
            entry["ai_generated"] = bool(raw_entry.get("ai_generated"))
        else:
            entry["ai_generated"] = True

        for flag_key in (
            "selectedByUser",
            "userSelected",
            "matchedByUser",
            "humanTagged",
            "human_tagged",
            "aiTagged",
            "ai_tagged",
        ):
            if flag_key in raw_entry:
                entry[flag_key] = bool(raw_entry.get(flag_key))

        for source_marker in ("selectionSource", "selection_source", "selectedSource"):
            marker_value = str(raw_entry.get(source_marker) or "").strip()
            if marker_value:
                entry[source_marker] = marker_value
    else:
        entry["ai_generated"] = True
    return entry


def _build_theme_word_identity_key(raw_entry) -> tuple[str, str, str, str, str] | None:
    entry = _build_theme_word_entry(raw_entry)
    if not isinstance(entry, dict):
        return None

    if entry.get("segmentId"):
        return (
            "segment",
            str(entry.get("sourceFile") or ""),
            str(entry["segmentId"]),
            str(entry.get("participant") or "").lower(),
            _normalize_theme_quote_text_key(entry.get("word")),
        )
    return (
        _normalize_theme_quote_text_key(entry.get("word")),
        _normalize_theme_participant_code(entry.get("participant") or entry.get("speaker")),
        _normalize_theme_qa_tag(entry.get("tag") or entry.get("speaker")),
        _normalize_theme_timestamp(entry.get("timestamp")),
        _normalize_theme_quote_text_key(entry.get("cueText")),
    )


def _build_theme_lookup_keys(raw_entry) -> list[str]:
    entry = _build_theme_word_entry(raw_entry)
    if not isinstance(entry, dict):
        return []

    text_key = _normalize_theme_quote_text_key(entry.get("word"))
    participant = _normalize_theme_participant_code(entry.get("participant") or entry.get("speaker"))
    tag = _normalize_theme_qa_tag(entry.get("tag") or entry.get("speaker"))
    timestamp = _normalize_theme_timestamp(entry.get("timestamp"))
    keys: list[str] = []
    if entry.get("segmentId"):
        return ["segment::" + json.dumps(_build_theme_word_identity_key(entry), ensure_ascii=False)]

    if participant and timestamp and tag:
        keys.append(f"cue::{participant}||{timestamp}||{tag}")
    if participant and timestamp:
        keys.append(f"cue::{participant}||{timestamp}||")

    if text_key:
        if participant and timestamp and tag:
            keys.append(f"text::{participant}||{timestamp}||{tag}||{text_key}")
        if participant and tag:
            keys.append(f"text::{participant}||{tag}||{text_key}")
        if participant:
            keys.append(f"text::{participant}||||{text_key}")
        if tag:
            keys.append(f"text::||{tag}||{text_key}")
        keys.append(f"text::||||{text_key}")

    return keys


def _resolve_theme_lookup_entry(theme_lookup: dict[str, dict], raw_entry):
    for key in _build_theme_lookup_keys(raw_entry):
        match = theme_lookup.get(key)
        if isinstance(match, dict):
            return match
    return None


def _build_output_quote_lookup(output_data) -> dict:
    lookup: dict[str, dict[str, dict]] = {}
    for theme_name, theme_data in _output_theme_entries(output_data):
        theme_lookup = lookup.setdefault(theme_name.lower(), {})
        quotes = theme_data.get("quotes", []) if isinstance(theme_data, dict) else []
        normalized_summary = _normalize_theme_quote_text_key(theme_data.get("summary") if isinstance(theme_data, dict) else "")
        for quote in quotes:
            entry = _build_theme_word_entry(quote)
            if not entry:
                continue
            if normalized_summary and _normalize_theme_quote_text_key(entry.get("word")) == normalized_summary:
                continue
            for key in _build_theme_lookup_keys(entry):
                if key and key not in theme_lookup:
                    theme_lookup[key] = entry
    return lookup


def _build_output_theme_metadata(output_data) -> dict:
    metadata: dict[str, dict] = {}
    for theme_name, theme_data in _output_theme_entries(output_data):
        if not isinstance(theme_data, dict):
            continue
        metadata[theme_name.lower()] = {
            "summary": str(theme_data.get("summary") or "").strip(),
            "groups": list(theme_data.get("groups", [])) if isinstance(theme_data.get("groups"), list) else [],
            "color": str(theme_data.get("color") or "").strip(),
            "comment": str(theme_data.get("comment") or "").strip(),
        }
    return metadata


def _enrich_theme_payload_with_output_lookup(
    theme_payload,
    quote_lookup: dict | None = None,
    theme_metadata: dict | None = None,
):
    if not isinstance(theme_payload, dict) or not isinstance(theme_payload.get("themes"), list):
        return theme_payload

    lookup = quote_lookup if isinstance(quote_lookup, dict) else {}
    metadata_lookup = theme_metadata if isinstance(theme_metadata, dict) else {}
    enriched_themes = []

    for theme in theme_payload.get("themes", []):
        if not isinstance(theme, dict):
            continue

        theme_name = str(theme.get("themeName") or theme.get("theme") or theme.get("name") or "").strip()
        if not theme_name:
            continue

        theme_lookup = lookup.get(theme_name.lower(), {})
        metadata = metadata_lookup.get(theme_name.lower(), {})
        output_summary = str(metadata.get("summary") or "").strip()
        normalized_summary = _normalize_theme_quote_text_key(output_summary)
        words = []
        for raw_word in theme.get("words", []):
            enriched_word = _build_theme_word_entry(
                raw_word,
                _resolve_theme_lookup_entry(theme_lookup, raw_word)
            )
            if enriched_word:
                if normalized_summary and _normalize_theme_quote_text_key(enriched_word.get("word")) == normalized_summary:
                    continue
                words.append(enriched_word)

        enriched_theme = dict(theme)
        enriched_theme["themeName"] = theme_name
        enriched_theme["words"] = words
        existing_summary = str(enriched_theme.get("summary") or "").strip()
        if output_summary or existing_summary:
            enriched_theme["summary"] = output_summary or existing_summary
        if not str(enriched_theme.get("color") or "").strip():
            enriched_theme["color"] = str(metadata.get("color") or "")
        if not isinstance(enriched_theme.get("groups"), list):
            enriched_theme["groups"] = list(metadata.get("groups", [])) if isinstance(metadata.get("groups"), list) else []
        if not str(enriched_theme.get("comment") or "").strip() and str(metadata.get("comment") or "").strip():
            enriched_theme["comment"] = str(metadata.get("comment") or "").strip()
        enriched_themes.append(enriched_theme)

    payload = {
        key: value
        for key, value in theme_payload.items()
        if key not in {"themes", "projectId", "project_id"}
    }
    payload["themes"] = enriched_themes
    return payload


def _load_output_theme_data(output_path: str):
    if not output_path or not os.path.exists(output_path):
        return None
    try:
        with open(output_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"[WARN] Failed to read ai_generated.json for theme object: {e}")
        return None


def _theme_entry_source_key(raw_entry) -> str:
    if not isinstance(raw_entry, dict):
        return ""
    return str(raw_entry.get("codeSource") or raw_entry.get("source") or raw_entry.get("tagSource") or "").strip().lower()


def _theme_entry_has_human_source(raw_entry) -> bool:
    if not isinstance(raw_entry, dict):
        return False
    source = _theme_entry_source_key(raw_entry)
    if source in {"manual", "human", "human_ai", "human+ai", "both"}:
        return True
    if raw_entry.get("humanTagged") is True or raw_entry.get("human_tagged") is True:
        return True
    return raw_entry.get("ai_generated") is False


def _theme_entry_has_ai_source(raw_entry) -> bool:
    if not isinstance(raw_entry, dict):
        return True
    source = _theme_entry_source_key(raw_entry)
    if source in {"human_ai", "human+ai", "both", "ai", "llm", "cloud"}:
        return True
    if raw_entry.get("aiTagged") is True or raw_entry.get("ai_tagged") is True:
        return True
    if raw_entry.get("ai_generated") is True:
        return True
    return not _theme_entry_has_human_source(raw_entry)


def _merge_theme_word_source_metadata(existing_entry: dict, candidate_entry: dict) -> dict:
    if not isinstance(existing_entry, dict):
        return existing_entry
    has_human = _theme_entry_has_human_source(existing_entry) or _theme_entry_has_human_source(candidate_entry)
    has_ai = _theme_entry_has_ai_source(existing_entry) or _theme_entry_has_ai_source(candidate_entry)
    if not (has_human and has_ai):
        return existing_entry
    merged_entry = dict(existing_entry)
    merged_entry["codeSource"] = "human_ai"
    merged_entry["source"] = "human_ai"
    merged_entry["ai_generated"] = True
    merged_entry["humanTagged"] = True
    merged_entry["aiTagged"] = True
    return merged_entry


def _merge_theme_payloads_preserving_manual(primary_payload, generated_payload, include_generated_only: bool = True) -> dict:
    primary_themes = primary_payload.get("themes") if isinstance(primary_payload, dict) else []
    generated_themes = generated_payload.get("themes") if isinstance(generated_payload, dict) else []
    if not isinstance(primary_themes, list):
        primary_themes = []
    if not isinstance(generated_themes, list):
        generated_themes = []

    archived_theme_names = {
        _normalize_theme_lookup_name(
            theme.get("themeName") or theme.get("theme") or theme.get("name") or theme.get("title")
        )
        for theme in (primary_payload.get("archivedCodes", []) if isinstance(primary_payload, dict) else [])
        if isinstance(theme, dict)
    }
    archived_theme_names.discard("")

    merged_themes = []
    index_by_name = {}
    for theme in primary_themes:
        if not isinstance(theme, dict):
            continue
        theme_name = str(theme.get("themeName") or theme.get("theme") or theme.get("name") or "").strip()
        if not theme_name:
            continue
        normalized_name = _normalize_theme_lookup_name(theme_name)
        if normalized_name in archived_theme_names:
            continue
        next_theme = dict(theme)
        next_theme["themeName"] = theme_name
        if not isinstance(next_theme.get("words"), list):
            next_theme["words"] = []
        merged_themes.append(next_theme)
        index_by_name[normalized_name] = next_theme

    for generated_theme in generated_themes:
        if not isinstance(generated_theme, dict):
            continue
        theme_name = str(generated_theme.get("themeName") or generated_theme.get("theme") or generated_theme.get("name") or "").strip()
        if not theme_name:
            continue
        normalized_name = _normalize_theme_lookup_name(theme_name)
        if normalized_name in archived_theme_names:
            continue
        target_theme = index_by_name.get(normalized_name)
        if target_theme is None:
            if not include_generated_only:
                continue
            next_theme = dict(generated_theme)
            next_theme["themeName"] = theme_name
            if not isinstance(next_theme.get("words"), list):
                next_theme["words"] = []
            merged_themes.append(next_theme)
            index_by_name[normalized_name] = next_theme
            continue

        target_words = list(target_theme.get("words", []) or [])
        index_by_word_key = {
            key: index
            for index, key in enumerate(_build_theme_word_identity_key(word) for word in target_words)
            if key
        }
        for generated_word in generated_theme.get("words", []) or []:
            entry = _build_theme_word_entry(generated_word)
            if not entry:
                continue
            key = _build_theme_word_identity_key(entry)
            if key and key in index_by_word_key:
                existing_index = index_by_word_key[key]
                target_words[existing_index] = _merge_theme_word_source_metadata(target_words[existing_index], entry)
                continue
            if key:
                index_by_word_key[key] = len(target_words)
            target_words.append(entry)
        target_theme["words"] = target_words
        if not str(target_theme.get("summary") or "").strip() and str(generated_theme.get("summary") or "").strip():
            target_theme["summary"] = str(generated_theme.get("summary") or "").strip()
        if not isinstance(target_theme.get("groups"), list) and isinstance(generated_theme.get("groups"), list):
            target_theme["groups"] = list(generated_theme.get("groups") or [])

    payload_source = primary_payload if isinstance(primary_payload, dict) else {}
    payload = {
        key: value
        for key, value in payload_source.items()
        if key not in {"themes", "projectId", "project_id"}
    }
    payload["themes"] = merged_themes
    return payload


def _normalize_hex_theme_color(value, fallback: str = "") -> str:
    raw_value = str(value or "").strip()
    if re.fullmatch(r"#[0-9A-Fa-f]{6}", raw_value):
        return raw_value.upper()
    if re.fullmatch(r"#[0-9A-Fa-f]{3}", raw_value):
        return "#" + "".join(channel * 2 for channel in raw_value[1:]).upper()
    return str(fallback or "").upper()


def _next_available_theme_color(used_colors: set[str], offset: int = 0) -> str:
    palette = [
        "#E7A23B",
        "#E14947",
        "#8EC053",
        "#579AE2",
        "#8E41D1",
        "#15AABF",
        "#F76707",
        "#2F9E44",
        "#D6336C",
        "#7048E8",
        "#0CA678",
        "#F59F00",
        "#1971C2",
        "#C2255C",
        "#5C940D",
        "#9C36B5",
    ]
    normalized_palette = [_normalize_hex_theme_color(color) for color in palette]
    for index in range(len(normalized_palette)):
        color = normalized_palette[(index + offset) % len(normalized_palette)]
        if color and color not in used_colors:
            return color
    return normalized_palette[offset % len(normalized_palette)] if normalized_palette else "#579AE2"


def _merge_unique_theme_arrays(*arrays):
    seen = set()
    merged = []
    for array_value in arrays:
        if not isinstance(array_value, list):
            continue
        for value in array_value:
            try:
                key = json.dumps(value, sort_keys=True, ensure_ascii=False) if isinstance(value, (dict, list)) else str(value)
            except TypeError:
                key = str(value)
            if key in seen:
                continue
            seen.add(key)
            merged.append(value)
    return merged


MANUAL_DELETION_INTENT_KEYS = ("manualDeletionIntent", "_manualDeletionIntent")


def _strip_manual_deletion_intent_keys(data: dict) -> dict:
    if not isinstance(data, dict):
        return data
    return {
        key: value
        for key, value in data.items()
        if key not in MANUAL_DELETION_INTENT_KEYS
    }


def _clean_selected_theme_words(theme: dict) -> list:
    summary_key = _normalize_theme_quote_text_key(theme.get("summary"))
    cleaned_words = []
    index_by_key = {}
    for word in theme.get("words", []) or []:
        if not isinstance(word, dict):
            if not summary_key or _normalize_theme_quote_text_key(word) != summary_key:
                cleaned_words.append(word)
            continue

        word_copy = dict(word)
        if summary_key and _normalize_theme_quote_text_key(word_copy.get("word") or word_copy.get("text")) == summary_key:
            continue

        source = str(word_copy.get("codeSource") or word_copy.get("source") or word_copy.get("tagSource") or "").strip().lower()
        if source in {"manual", "human"}:
            word_copy["ai_generated"] = False
        elif source in {"ai", "llm", "cloud"}:
            word_copy["ai_generated"] = True
        elif "ai_generated" in word_copy:
            word_copy["ai_generated"] = bool(word_copy.get("ai_generated"))
        else:
            word_copy["ai_generated"] = True

        identity_key = _build_theme_word_identity_key(word_copy)
        if identity_key and identity_key in index_by_key:
            existing_index = index_by_key[identity_key]
            cleaned_words[existing_index] = _merge_theme_word_source_metadata(cleaned_words[existing_index], word_copy)
            continue
        if identity_key:
            index_by_key[identity_key] = len(cleaned_words)
        cleaned_words.append(word_copy)
    return cleaned_words


def _merge_selected_theme_records(existing_theme: dict, candidate_theme: dict) -> dict:
    merged_theme = dict(existing_theme)
    existing_words = list(existing_theme.get("words", []) or [])
    candidate_words = list(candidate_theme.get("words", []) or [])
    merged_theme["words"] = _clean_selected_theme_words({
        **merged_theme,
        "words": existing_words + candidate_words,
    })
    merged_theme["highlight"] = _merge_unique_theme_arrays(existing_theme.get("highlight"), candidate_theme.get("highlight"))
    merged_theme["groups"] = _merge_unique_theme_arrays(existing_theme.get("groups"), candidate_theme.get("groups"))
    if not str(merged_theme.get("summary") or "").strip() and str(candidate_theme.get("summary") or "").strip():
        merged_theme["summary"] = str(candidate_theme.get("summary") or "").strip()
    if not str(merged_theme.get("comment") or "").strip() and str(candidate_theme.get("comment") or "").strip():
        merged_theme["comment"] = str(candidate_theme.get("comment") or "")
    if not _normalize_hex_theme_color(merged_theme.get("color")) and _normalize_hex_theme_color(candidate_theme.get("color")):
        merged_theme["color"] = _normalize_hex_theme_color(candidate_theme.get("color"))
    for key in ("selectedByUser", "selectionSource", "selectionStage"):
        if key in candidate_theme and key not in merged_theme:
            merged_theme[key] = candidate_theme[key]
    return merged_theme


def _canonicalize_selected_theme_records(raw_themes) -> list:
    if not isinstance(raw_themes, list):
        raw_themes = []

    themes = []
    index_by_name = {}
    for theme in raw_themes:
        if not isinstance(theme, dict):
            continue
        theme_name = str(theme.get("themeName") or theme.get("theme") or theme.get("name") or theme.get("title") or "").strip()
        normalized_name = _normalize_theme_lookup_name(theme_name)
        if not theme_name or not normalized_name:
            continue

        next_theme = dict(theme)
        next_theme["themeName"] = theme_name
        next_theme["summary"] = str(next_theme.get("summary") or "").strip()
        next_theme["comment"] = str(next_theme.get("comment") or "")
        next_theme["highlight"] = list(next_theme.get("highlight", [])) if isinstance(next_theme.get("highlight"), list) else []
        next_theme["groups"] = list(next_theme.get("groups", [])) if isinstance(next_theme.get("groups"), list) else []
        next_theme["words"] = _clean_selected_theme_words(next_theme)

        if normalized_name in index_by_name:
            existing_index = index_by_name[normalized_name]
            themes[existing_index] = _merge_selected_theme_records(themes[existing_index], next_theme)
            continue

        index_by_name[normalized_name] = len(themes)
        themes.append(next_theme)

    used_colors = set()
    for index, theme in enumerate(themes):
        color = _normalize_hex_theme_color(theme.get("color"))
        if not color or color in used_colors:
            color = _next_available_theme_color(used_colors, index)
        theme["color"] = color
        used_colors.add(color)

    return themes


def _canonicalize_selected_theme_payload(data) -> dict:
    if not isinstance(data, dict):
        return {"themes": []}

    themes = _canonicalize_selected_theme_records(data.get("themes", []))
    has_archived_codes = "archivedCodes" in data
    archived_codes = _canonicalize_selected_theme_records(data.get("archivedCodes", [])) if has_archived_codes else []
    archived_names = {
        _normalize_theme_lookup_name(theme.get("themeName"))
        for theme in archived_codes
        if isinstance(theme, dict)
    }
    archived_names.discard("")
    if archived_names:
        themes = [
            theme
            for theme in themes
            if _normalize_theme_lookup_name(theme.get("themeName")) not in archived_names
        ]

    payload = {
        key: value
        for key, value in data.items()
        if key not in {"themes", "archivedCodes", "projectId", "project_id", *MANUAL_DELETION_INTENT_KEYS}
    }
    payload["themes"] = themes
    if has_archived_codes:
        payload["archivedCodes"] = archived_codes
    if "manualSelectionOptOuts" in data:
        payload["manualSelectionOptOuts"] = _normalize_manual_selection_opt_outs(data)
    return payload


def _validated_selected_theme_base(selected_payload):
    if not isinstance(selected_payload, dict):
        return None
    if not isinstance(selected_payload.get("themes"), list):
        return None

    valid_themes = [
        theme for theme in selected_payload["themes"]
        if isinstance(theme, dict) and str(theme.get("themeName", "")).strip()
    ]
    if not valid_themes and not selected_payload.get("archivedCodes"):
        return None

    selected_base = {
        key: value
        for key, value in selected_payload.items()
        if key not in {"themes", "projectId", "project_id"}
    }
    selected_base["themes"] = valid_themes
    return selected_base


def _merge_newer_generated_themes(output_path, selected_path, selected_payload, generated_payload):
    try:
        if os.path.getmtime(output_path) > os.path.getmtime(selected_path):
            merged_payload = _merge_theme_payloads_preserving_manual(
                selected_payload, generated_payload
            )
            return _canonicalize_selected_theme_payload(merged_payload)
    except OSError:
        pass
    return _canonicalize_selected_theme_payload(selected_payload)


def _read_preferred_selected_themes(output_path, quote_lookup, theme_metadata):
    selected_path = os.path.join(os.path.dirname(output_path), "SelectedThemes.json")
    if not os.path.exists(selected_path):
        return None

    try:
        with open(selected_path, "r", encoding="utf-8") as selected_file:
            selected_payload = json.load(selected_file)
        selected_payload = _enrich_theme_payload_with_output_lookup(
            selected_payload, quote_lookup, theme_metadata
        )
        selected_base = _validated_selected_theme_base(selected_payload)
        if selected_base is None:
            return None

        generated_payload = build_theme_object_from_output(output_path, prefer_selected=False)
        return _merge_newer_generated_themes(
            output_path, selected_path, selected_base, generated_payload
        )
    except Exception as error:
        print(f"[WARN] Failed to read SelectedThemes.json for theme object: {error}")
        return None


def build_theme_object_from_output(output_path: str, prefer_selected: bool = True):
    if not output_path or not os.path.exists(output_path):
        return {"themes": []}

    output_data = _load_output_theme_data(output_path)
    quote_lookup = _build_output_quote_lookup(output_data) if output_data is not None else {}
    theme_metadata = _build_output_theme_metadata(output_data) if output_data is not None else {}

    if prefer_selected:
        selected_payload = _read_preferred_selected_themes(output_path, quote_lookup, theme_metadata)
        if selected_payload is not None:
            return selected_payload

    data = output_data
    if data is None:
        return {"themes": []}

    themes = []
    def build_words_from_quotes(quotes, summary: str = ""):
        words = []
        seen = set()
        normalized_summary = _normalize_theme_quote_text_key(summary)
        for quote in quotes or []:
            entry = _build_theme_word_entry(quote)
            if not entry:
                continue
            if normalized_summary and _normalize_theme_quote_text_key(entry.get("word")) == normalized_summary:
                continue
            dedupe_key = _build_theme_word_identity_key(entry)
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)
            words.append(entry)
        return words

    for idx, (title, theme_data) in enumerate(_output_theme_entries(data)):
        quotes = theme_data.get("quotes", []) if isinstance(theme_data, dict) else []
        summary = str(theme_data.get("summary") or "").strip() if isinstance(theme_data, dict) else ""
        color = _normalize_hex_theme_color(
            theme_data.get("color") if isinstance(theme_data, dict) else "",
            THEME_COLOR_PALETTE[idx % len(THEME_COLOR_PALETTE)]
        )
        themes.append({
            "themeName": title,
            "color": color,
            "summary": summary,
            "words": build_words_from_quotes(quotes, summary),
            "groups": list(theme_data.get("groups", []))
            if isinstance(theme_data, dict) and isinstance(theme_data.get("groups", []), list)
            else []
        })

    return _canonicalize_selected_theme_payload({"themes": themes})


def _load_selected_theme_payload(output_dir: str | None) -> dict:
    if not output_dir:
        return {"themes": []}

    selected_path = os.path.join(output_dir, "SelectedThemes.json")
    if not os.path.exists(selected_path):
        return {"themes": []}

    try:
        with open(selected_path, 'r', encoding='utf-8') as f:
            data = json.load(f)

        output_path = os.path.join(output_dir, "ai_generated.json")
        output_data = _load_output_theme_data(output_path)
        if output_data is not None:
            data = _enrich_theme_payload_with_output_lookup(
                data,
                _build_output_quote_lookup(output_data),
                _build_output_theme_metadata(output_data)
            )

        if isinstance(data, dict) and isinstance(data.get("themes"), list):
            valid_themes = [
                theme for theme in data.get("themes", [])
                if isinstance(theme, dict) and str(theme.get("themeName", "")).strip()
            ]
            payload = {
                key: value
                for key, value in data.items()
                if key not in {"projectId", "project_id"}
            }
            payload["themes"] = valid_themes
            return _canonicalize_selected_theme_payload(payload)
    except Exception as e:
        print(f"[WARN] Failed to load SelectedThemes.json payload: {e}")

    return {"themes": []}


def _merge_generated_quotes_into_theme_payload(theme_payload, output_dir: str | None) -> dict:
    if not isinstance(theme_payload, dict) or not isinstance(theme_payload.get("themes"), list):
        return {"themes": []}
    if not output_dir:
        return theme_payload

    output_path = os.path.join(output_dir, "ai_generated.json")
    output_data = _load_output_theme_data(output_path)
    if output_data is None:
        return theme_payload

    merged_themes = []
    for theme in theme_payload.get("themes", []):
        if not isinstance(theme, dict):
            continue

        theme_name = str(theme.get("themeName") or theme.get("theme") or theme.get("name") or "").strip()
        if not theme_name:
            continue

        merged_theme = dict(theme)
        generated_key = _find_theme_key_in_output(output_data, theme_name) if isinstance(output_data, dict) else None
        generated_payload = output_data.get(generated_key) if generated_key else None
        generated_summary = str(generated_payload.get("summary") or "").strip() if isinstance(generated_payload, dict) else ""
        normalized_summary = _normalize_theme_quote_text_key(generated_summary)

        words = []
        index_by_key = {}
        for raw_word in list(theme.get("words", []) or []):
            entry = _build_theme_word_entry(raw_word)
            if not entry:
                continue
            if normalized_summary and _normalize_theme_quote_text_key(entry.get("word")) == normalized_summary:
                continue
            key = _build_theme_word_identity_key(entry)
            if key and key in index_by_key:
                words[index_by_key[key]] = _merge_theme_word_source_metadata(words[index_by_key[key]], entry)
                continue
            if key:
                index_by_key[key] = len(words)
            words.append(entry)

        if isinstance(generated_payload, dict):
            for raw_quote in generated_payload.get("quotes", []) or []:
                entry = _build_theme_word_entry(raw_quote)
                if not entry:
                    continue
                if normalized_summary and _normalize_theme_quote_text_key(entry.get("word")) == normalized_summary:
                    continue
                key = _build_theme_word_identity_key(entry)
                if key and key in index_by_key:
                    words[index_by_key[key]] = _merge_theme_word_source_metadata(words[index_by_key[key]], entry)
                    continue
                if key:
                    index_by_key[key] = len(words)
                words.append(entry)

        merged_theme["themeName"] = theme_name
        merged_theme["words"] = words
        if generated_summary and not str(merged_theme.get("summary") or "").strip():
            merged_theme["summary"] = generated_summary
        merged_themes.append(merged_theme)

    payload_source = theme_payload if isinstance(theme_payload, dict) else {}
    payload = {
        key: value
        for key, value in payload_source.items()
        if key not in {"themes", "projectId", "project_id"}
    }
    payload["themes"] = merged_themes
    return payload


def _theme_entry_is_manual(raw_entry) -> bool:
    if not isinstance(raw_entry, dict):
        return False
    source = str(raw_entry.get("codeSource") or raw_entry.get("source") or raw_entry.get("tagSource") or "").strip().lower()
    if source in {"manual", "human", "human_ai", "human+ai", "both"}:
        return True
    if source in {"ai", "llm", "cloud"}:
        return False
    if raw_entry.get("humanTagged") is True or raw_entry.get("human_tagged") is True:
        return True
    if "ai_generated" in raw_entry:
        return raw_entry.get("ai_generated") is False
    return False


def _normalize_manual_selection_opt_outs(source) -> dict:
    raw = source.get("manualSelectionOptOuts") if isinstance(source, dict) and isinstance(source.get("manualSelectionOptOuts"), dict) else source
    raw = raw if isinstance(raw, dict) else {}

    def normalize_values(values):
        if not isinstance(values, list):
            return []
        return sorted({str(value or "").strip().lower() for value in values if str(value or "").strip()})

    return {
        "codes": normalize_values(raw.get("codes")),
        "excerpts": normalize_values(raw.get("excerpts")),
    }


def _manual_code_selection_key(theme_name) -> str:
    return _normalize_theme_lookup_name(theme_name).replace(" ", "")


def _manual_excerpt_selection_key(theme_name, word_entry) -> str:
    code_key = _manual_code_selection_key(theme_name)
    identity = _build_theme_word_identity_key(word_entry)
    excerpt_key = "||".join(
        str(value or "").lower()
        for value in (identity[1], identity[2], identity[3], identity[4], identity[0])
    ) if identity else ""
    return f"{code_key}::{excerpt_key}" if code_key and excerpt_key else ""


def _manual_theme_is_opted_out(source, theme_name) -> bool:
    code_key = _manual_code_selection_key(theme_name)
    return bool(code_key and code_key in _normalize_manual_selection_opt_outs(source)["codes"])


def _manual_excerpt_is_opted_out(source, theme_name, word_entry) -> bool:
    excerpt_key = _manual_excerpt_selection_key(theme_name, word_entry)
    return bool(excerpt_key and excerpt_key in _normalize_manual_selection_opt_outs(source)["excerpts"])


def _migrate_manual_selection_theme_name(source, old_name, new_name) -> dict:
    opt_outs = _normalize_manual_selection_opt_outs(source)
    old_key = _manual_code_selection_key(old_name)
    new_key = _manual_code_selection_key(new_name)
    if not old_key or not new_key or old_key == new_key:
        return opt_outs

    codes = set(opt_outs["codes"])
    if old_key in codes:
        codes.remove(old_key)
        codes.add(new_key)
    old_prefix = f"{old_key}::"
    excerpts = [
        f"{new_key}::{value[len(old_prefix):]}" if value.startswith(old_prefix) else value
        for value in opt_outs["excerpts"]
    ]
    return _normalize_manual_selection_opt_outs({"codes": list(codes), "excerpts": excerpts})


def _theme_entry_is_user_selected(raw_entry) -> bool:
    if not isinstance(raw_entry, dict):
        return False
    if raw_entry.get("selectedByUser") is True:
        return True
    if raw_entry.get("appliedToVisualization") is True:
        return True
    selection_source = str(raw_entry.get("selectionSource") or raw_entry.get("selectedSource") or "").strip().lower()
    return selection_source in {
        "matching_excerpts",
        "matching-excerpts",
        "selected_excerpts",
        "theme_excerpt_selection",
        "user_selection",
        "ai_generate_more_codes",
        "ai_more_codes_generated",
        "manual_codes",
        "manual_code",
        "human_manual_code",
    }


def _manual_entry_hidden_from_visualization_display(raw_entry, payload=None, theme_name="") -> bool:
    if not isinstance(raw_entry, dict):
        return False
    if not _theme_entry_is_manual(raw_entry):
        return False
    if theme_name and raw_entry.get("word"):
        return _manual_theme_is_opted_out(payload, theme_name) or _manual_excerpt_is_opted_out(payload, theme_name, raw_entry)
    return _manual_theme_is_opted_out(payload, theme_name or raw_entry.get("themeName"))


def _filter_theme_payload_for_visualization_display(theme_payload) -> dict:
    if not isinstance(theme_payload, dict) or not isinstance(theme_payload.get("themes"), list):
        return {"themes": []}

    filtered_themes = []
    for raw_theme in theme_payload.get("themes", []):
        if not isinstance(raw_theme, dict):
            continue
        theme_name = str(raw_theme.get("themeName") or raw_theme.get("theme") or raw_theme.get("name") or "").strip()
        if not theme_name:
            continue

        filtered_words = []
        for raw_word in raw_theme.get("words", []) if isinstance(raw_theme.get("words"), list) else []:
            if not isinstance(raw_word, dict):
                filtered_words.append(raw_word)
                continue
            if _manual_entry_hidden_from_visualization_display(raw_word, theme_payload, theme_name):
                continue
            filtered_words.append(raw_word)

        theme_hidden = (
            _manual_entry_hidden_from_visualization_display(raw_theme, theme_payload, theme_name)
            or (_theme_contains_manual_word(raw_theme) and _manual_theme_is_opted_out(theme_payload, theme_name))
        )
        if theme_hidden:
            continue

        next_theme = dict(raw_theme)
        next_theme["themeName"] = theme_name
        next_theme["words"] = filtered_words
        filtered_themes.append(next_theme)

    filtered_payload = {
        key: value
        for key, value in theme_payload.items()
        if key not in {"themes", "projectId", "project_id", *MANUAL_DELETION_INTENT_KEYS}
    }
    filtered_payload["themes"] = filtered_themes
    return _canonicalize_selected_theme_payload(filtered_payload)


def _theme_payload_applied_to_visualization(payload) -> bool:
    if not isinstance(payload, dict):
        return False
    if payload.get("appliedToVisualization") is True:
        return True
    selection_stage = str(payload.get("selectionStage") or "").strip().lower()
    if selection_stage in {"applied_codes", "apply_codes", "visualization_applied", "code_manager"}:
        return True
    selection_source = str(payload.get("selectionSource") or "").strip().lower()
    return selection_source in {
        "apply_codes",
        "applied_codes",
        "visualization_applied",
        "ai_generate_more_codes",
        "ai_more_codes_generated",
    }


def _mark_ai_generated_code_payload_applied(theme_payload, source: str = "ai_generate_more_codes") -> dict:
    if not isinstance(theme_payload, dict):
        return {"themes": []}

    synced_payload = dict(theme_payload)
    timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    synced_payload["appliedToVisualization"] = True
    synced_payload["selectionSource"] = source
    synced_payload["selectionStage"] = "applied_codes"
    synced_payload["appliedAt"] = synced_payload.get("appliedAt") or timestamp
    synced_payload["updatedAt"] = timestamp
    synced_payload.pop("visualizationPreviewState", None)

    synced_themes = []
    for theme in synced_payload.get("themes", []) if isinstance(synced_payload.get("themes"), list) else []:
        if not isinstance(theme, dict):
            continue
        next_theme = dict(theme)
        next_theme.setdefault("selectionSource", source)
        next_theme.setdefault("selectionStage", "applied_codes")
        next_words = []
        for word in next_theme.get("words", []) if isinstance(next_theme.get("words"), list) else []:
            if not isinstance(word, dict):
                next_words.append(word)
                continue
            next_word = dict(word)
            if not _theme_entry_is_manual(next_word):
                next_word.setdefault("codeSource", "ai")
                next_word.setdefault("selectionSource", source)
                next_word.setdefault("selectionStage", "applied_codes")
                next_word["ai_generated"] = True
            next_words.append(next_word)
        next_theme["words"] = next_words
        synced_themes.append(next_theme)
    synced_payload["themes"] = synced_themes
    return synced_payload


MATCHING_EXCERPT_SELECTION_STAGES = {"matching_excerpts", "matching_excerpts_selected"}
MATCHING_EXCERPT_SELECTION_SOURCES = {"matching_excerpts", "selected_excerpts", "theme_excerpt_selection"}
APPLIED_VISUALIZATION_SELECTION_STAGES = {"applied_codes", "apply_codes", "visualization_applied"}
APPLIED_VISUALIZATION_SELECTION_SOURCES = {
    "applied_codes",
    "apply_codes",
    "visualization_applied",
    "manual_codes",
    "ai_generate_more_codes",
    "ai_more_codes_generated",
    "demo_preload",
}


def _theme_payload_is_matching_excerpt_mode(payload) -> bool:
    if not isinstance(payload, dict):
        return False

    preview_state = str(payload.get("visualizationPreviewState") or "").strip().lower()
    selection_stage = str(payload.get("selectionStage") or "").strip().lower()
    selection_source = str(payload.get("selectionSource") or "").strip().lower()
    return (
        preview_state == "matching_excerpts_unapplied"
        or selection_stage in MATCHING_EXCERPT_SELECTION_STAGES
        or selection_source in MATCHING_EXCERPT_SELECTION_SOURCES
    )


def _theme_entry_is_matching_excerpt_selection(raw_entry) -> bool:
    if not isinstance(raw_entry, dict):
        return False

    word_stage = str(raw_entry.get("selectionStage") or "").strip().lower()
    word_source = str(raw_entry.get("selectionSource") or raw_entry.get("selectedSource") or "").strip().lower()
    has_matching_marker = (
        raw_entry.get("selectedInMatching") is True
        or raw_entry.get("matchingSelection") is True
    )
    has_user_selection_marker = (
        raw_entry.get("selectedByUser") is True
        or raw_entry.get("userSelected") is True
        or raw_entry.get("matchedByUser") is True
    )
    return has_matching_marker or word_stage in MATCHING_EXCERPT_SELECTION_STAGES or (
        has_user_selection_marker
        and word_source in MATCHING_EXCERPT_SELECTION_SOURCES
    )


def _theme_word_should_show_in_final_visualization(raw_entry) -> bool:
    if not isinstance(raw_entry, dict):
        return False
    if _theme_entry_is_matching_excerpt_selection(raw_entry):
        return True

    has_user_selection_marker = (
        raw_entry.get("selectedByUser") is True
        or raw_entry.get("userSelected") is True
        or raw_entry.get("matchedByUser") is True
    )
    if not has_user_selection_marker:
        return False

    selection_source = str(raw_entry.get("selectionSource") or raw_entry.get("selectedSource") or "").strip().lower()
    selection_stage = str(raw_entry.get("selectionStage") or "").strip().lower()
    return (
        selection_source in MATCHING_EXCERPT_SELECTION_SOURCES
        or selection_stage in MATCHING_EXCERPT_SELECTION_STAGES
        or selection_source in APPLIED_VISUALIZATION_SELECTION_SOURCES
        or selection_stage in APPLIED_VISUALIZATION_SELECTION_STAGES
    )


def _matching_excerpt_visualization_payload(payload) -> dict:
    if not isinstance(payload, dict) or not isinstance(payload.get("themes"), list):
        return {"themes": []}

    next_payload = {
        key: value
        for key, value in payload.items()
        if key not in {"themes", "projectId", "project_id", *MANUAL_DELETION_INTENT_KEYS}
    }
    next_themes = []
    for theme in payload.get("themes", []):
        if not isinstance(theme, dict):
            continue
        theme_name = str(theme.get("themeName") or theme.get("theme") or theme.get("name") or "").strip()
        if not theme_name:
            continue
        raw_words = theme.get("words")
        selected_words = [
            word
            for word in (raw_words if isinstance(raw_words, list) else [])
            if (
                not _manual_theme_is_opted_out(payload, theme_name)
                and (
                    (_theme_entry_is_manual(word) and not _manual_excerpt_is_opted_out(payload, theme_name, word))
                    or (not _theme_entry_is_manual(word) and _theme_entry_is_matching_excerpt_selection(word))
                )
            )
        ]
        if not selected_words:
            continue
        next_theme = dict(theme)
        next_theme["themeName"] = theme_name
        next_theme["words"] = selected_words
        next_themes.append(next_theme)

    next_payload["themes"] = next_themes
    return _canonicalize_selected_theme_payload(next_payload)


def _theme_entry_has_explicit_ai_marker(raw_entry) -> bool:
    if not isinstance(raw_entry, dict):
        return False
    source = _theme_entry_source_key(raw_entry)
    if source in {"human_ai", "human+ai", "both", "ai", "llm", "cloud"}:
        return True
    if raw_entry.get("aiTagged") is True or raw_entry.get("ai_tagged") is True:
        return True
    return raw_entry.get("ai_generated") is True


def _theme_entry_has_manual_code_marker(raw_entry) -> bool:
    if not isinstance(raw_entry, dict):
        return False
    if _theme_entry_is_manual(raw_entry):
        return True
    selection_source = str(raw_entry.get("selectionSource") or raw_entry.get("selectedSource") or "").strip().lower()
    return selection_source in {"manual_codes", "manual_code", "human_manual_code"}


def _theme_entry_is_manual_only(raw_entry) -> bool:
    return _theme_entry_has_manual_code_marker(raw_entry) and not _theme_entry_has_explicit_ai_marker(raw_entry)


def _filter_unselected_entries_for_final_visualization(theme_payload) -> dict:
    if not isinstance(theme_payload, dict) or not isinstance(theme_payload.get("themes"), list):
        return {"themes": []}

    filtered_themes = []
    for raw_theme in theme_payload.get("themes", []):
        if not isinstance(raw_theme, dict):
            continue
        theme_name = str(raw_theme.get("themeName") or raw_theme.get("theme") or raw_theme.get("name") or "").strip()
        if not theme_name:
            continue
        if (
            (_theme_entry_is_manual(raw_theme) or _theme_contains_manual_word(raw_theme))
            and _manual_theme_is_opted_out(theme_payload, theme_name)
        ):
            continue

        raw_words = raw_theme.get("words")
        words = raw_words if isinstance(raw_words, list) else []
        filtered_words = [
            word
            for word in words
            if (
                (_theme_entry_is_manual(word)
                 and not _manual_theme_is_opted_out(theme_payload, theme_name)
                 and not _manual_excerpt_is_opted_out(theme_payload, theme_name, word))
                or (not _theme_entry_is_manual(word) and _theme_word_should_show_in_final_visualization(word))
            )
        ]
        if not filtered_words:
            continue

        next_theme = dict(raw_theme)
        next_theme["themeName"] = theme_name
        next_theme["words"] = filtered_words
        filtered_themes.append(next_theme)

    filtered_payload = {
        key: value
        for key, value in theme_payload.items()
        if key not in {"themes", "projectId", "project_id", *MANUAL_DELETION_INTENT_KEYS}
    }
    filtered_payload["themes"] = filtered_themes
    return _canonicalize_selected_theme_payload(filtered_payload)


def _final_visualization_display_payload(theme_payload) -> dict:
    filtered_payload = _filter_unselected_entries_for_final_visualization(theme_payload)
    return filtered_payload if _has_theme_payload(filtered_payload) else _neutral_visualization_preview_payload()


def _theme_payload_is_matching_excerpt_selection(payload) -> bool:
    if not _has_theme_payload(payload):
        return False
    matching_payload = _matching_excerpt_visualization_payload(payload)
    matching_themes = matching_payload.get("themes", []) if isinstance(matching_payload, dict) else []
    return any(
        isinstance(theme, dict)
        and isinstance(theme.get("words"), list)
        and len(theme.get("words")) > 0
        for theme in matching_themes
    )


def _theme_contains_manual_word(theme) -> bool:
    if not isinstance(theme, dict):
        return False
    return any(_theme_entry_is_manual(word) for word in (theme.get("words", []) or []))


def _theme_has_user_selection_marker(theme) -> bool:
    if _theme_entry_is_user_selected(theme):
        return True
    if not isinstance(theme, dict):
        return False
    return any(_theme_entry_is_user_selected(word) for word in (theme.get("words", []) or []))


def _filter_unmarked_generated_only_theme_pollution(selected_payload, output_path: str) -> dict:
    if not _has_theme_payload(selected_payload) or _theme_entry_is_user_selected(selected_payload):
        return selected_payload if isinstance(selected_payload, dict) else {"themes": []}

    generated_payload = build_theme_object_from_output(output_path, prefer_selected=False)
    generated_only_theme_names = set()
    for theme in generated_payload.get("themes", []) if isinstance(generated_payload, dict) else []:
        if not isinstance(theme, dict):
            continue
        theme_name = str(theme.get("themeName") or theme.get("theme") or theme.get("name") or "").strip()
        if not theme_name:
            continue
        words = theme.get("words", []) or []
        if words and not _theme_contains_manual_word(theme) and not _theme_entry_is_manual(theme):
            generated_only_theme_names.add(_normalize_theme_lookup_name(theme_name))

    if len(generated_only_theme_names) < 2:
        return selected_payload

    selected_generated_only_unmarked_names = set()
    for theme in selected_payload.get("themes", []) or []:
        if not isinstance(theme, dict):
            continue
        theme_name = str(theme.get("themeName") or theme.get("theme") or theme.get("name") or "").strip()
        normalized_name = _normalize_theme_lookup_name(theme_name)
        if (
            normalized_name in generated_only_theme_names
            and not _theme_contains_manual_word(theme)
            and not _theme_has_user_selection_marker(theme)
        ):
            selected_generated_only_unmarked_names.add(normalized_name)

    if not generated_only_theme_names.issubset(selected_generated_only_unmarked_names):
        return selected_payload

    filtered_themes = []
    for theme in (selected_payload.get("themes", []) or []):
        if not isinstance(theme, dict):
            continue
        theme_name = str(theme.get("themeName") or theme.get("theme") or theme.get("name") or "").strip()
        if _normalize_theme_lookup_name(theme_name) in selected_generated_only_unmarked_names:
            continue
        filtered_themes.append(theme)
    filtered_payload = dict(selected_payload)
    filtered_payload["themes"] = filtered_themes
    return filtered_payload


def _manual_theme_payload_from_output(output_path: str) -> dict:
    generated_payload = build_theme_object_from_output(output_path, prefer_selected=False)
    return _manual_only_theme_payload_from_theme_payload(generated_payload)


def _manual_only_theme_payload_from_theme_payload(theme_payload) -> dict:
    manual_themes = []
    for theme in theme_payload.get("themes", []) if isinstance(theme_payload, dict) else []:
        if not isinstance(theme, dict):
            continue
        theme_name = str(theme.get("themeName") or theme.get("theme") or theme.get("name") or "").strip()
        if not theme_name:
            continue
        manual_words = [
            word
            for word in (theme.get("words", []) or [])
            if _theme_entry_is_manual(word)
        ]
        if not manual_words and not _theme_entry_is_manual(theme):
            continue
        next_theme = dict(theme)
        next_theme["themeName"] = theme_name
        next_theme["words"] = manual_words
        manual_themes.append(next_theme)
    return {"themes": manual_themes}


def _neutral_visualization_preview_payload(reason: str = "neutral_unapplied") -> dict:
    return {
        "themes": [],
        "visualizationPreviewState": reason,
    }


def _manual_visualization_payload(payload: dict) -> dict:
    if not isinstance(payload, dict):
        return {"themes": []}
    next_payload = dict(payload)
    next_payload["appliedToVisualization"] = True
    next_payload["selectionStage"] = "applied_codes"
    next_payload["selectionSource"] = "manual_codes"
    next_payload.pop("visualizationPreviewState", None)
    return next_payload


def _extract_manual_deletion_intent(data) -> dict:
    intent = {
        "themeNames": set(),
        "wordKeysByTheme": defaultdict(set),
    }
    if not isinstance(data, dict):
        return intent

    raw_intent = None
    for key in MANUAL_DELETION_INTENT_KEYS:
        candidate = data.get(key)
        if isinstance(candidate, dict):
            raw_intent = candidate
            break
    if not isinstance(raw_intent, dict):
        return intent

    def as_list(value):
        if isinstance(value, list):
            return value
        if value is None:
            return []
        return [value]

    theme_items = []
    for key in ("themes", "themeNames", "deletedThemes", "codes", "codeNames"):
        theme_items.extend(as_list(raw_intent.get(key)))
    for item in theme_items:
        if isinstance(item, dict):
            theme_name = item.get("themeName") or item.get("theme") or item.get("name") or item.get("title")
        else:
            theme_name = item
        normalized_name = _normalize_theme_lookup_name(theme_name)
        if normalized_name:
            intent["themeNames"].add(normalized_name)

    word_items = []
    for key in ("words", "quotes", "deletedWords", "deletedQuotes", "excerpts"):
        word_items.extend(as_list(raw_intent.get(key)))
    for item in word_items:
        if not isinstance(item, dict):
            continue
        theme_name = item.get("themeName") or item.get("theme") or item.get("name") or item.get("title")
        normalized_name = _normalize_theme_lookup_name(theme_name)
        identity_key = _build_theme_word_identity_key(item)
        if normalized_name and identity_key:
            intent["wordKeysByTheme"][normalized_name].add(identity_key)

    return intent


def _manual_theme_name_sets_from_output_dir(output_dir: str | None) -> tuple[set[str], set[str]]:
    if not output_dir:
        return set(), set()
    output_data = _load_output_theme_data(os.path.join(output_dir, "ai_generated.json"))
    if output_data is None:
        return set(), set()

    output_names = set()
    manual_output_names = set()
    for theme_name, theme_data in _output_theme_entries(output_data):
        normalized_name = _normalize_theme_lookup_name(theme_name)
        if not normalized_name:
            continue
        output_names.add(normalized_name)
        if _theme_entry_is_manual(theme_data):
            manual_output_names.add(normalized_name)
            continue
        if isinstance(theme_data, dict):
            quotes = theme_data.get("quotes")
            if isinstance(quotes, list) and any(_theme_entry_is_manual(quote) for quote in quotes):
                manual_output_names.add(normalized_name)
    return output_names, manual_output_names


def _selected_theme_record_is_manual(theme: dict, output_names: set[str], manual_output_names: set[str]) -> bool:
    if not isinstance(theme, dict):
        return False
    theme_name = str(theme.get("themeName") or theme.get("theme") or theme.get("name") or "").strip()
    normalized_name = _normalize_theme_lookup_name(theme_name)
    if not normalized_name:
        return False
    if _theme_entry_is_manual(theme) or _theme_contains_manual_word(theme):
        return True
    selection_source = str(theme.get("selectionSource") or theme.get("selectedSource") or "").strip().lower()
    if selection_source in {"manual_codes", "manual_code", "human_manual_code"}:
        return True
    words = theme.get("words")
    has_words = isinstance(words, list) and len(words) > 0
    if not has_words and (normalized_name in manual_output_names or normalized_name not in output_names):
        return True
    return False


def _merge_existing_manual_entries_for_save(next_payload, existing_payload, output_dir: str | None, deletion_intent: dict | None = None) -> dict:
    next_payload = _canonicalize_selected_theme_payload(
        _strip_manual_deletion_intent_keys(next_payload if isinstance(next_payload, dict) else {})
    )
    existing_payload = _canonicalize_selected_theme_payload(
        _strip_manual_deletion_intent_keys(existing_payload if isinstance(existing_payload, dict) else {})
    )
    if not _has_theme_payload(existing_payload):
        return next_payload

    deletion_intent = deletion_intent if isinstance(deletion_intent, dict) else {}
    deleted_theme_names = deletion_intent.get("themeNames") if isinstance(deletion_intent.get("themeNames"), set) else set()
    deleted_word_keys_by_theme = (
        deletion_intent.get("wordKeysByTheme")
        if isinstance(deletion_intent.get("wordKeysByTheme"), dict)
        else {}
    )
    output_names, manual_output_names = _manual_theme_name_sets_from_output_dir(output_dir)

    merged_payload = {
        key: value
        for key, value in next_payload.items()
        if key not in {"themes", "projectId", "project_id", *MANUAL_DELETION_INTENT_KEYS}
    }
    merged_themes = []
    index_by_name = {}
    for theme in next_payload.get("themes", []) if isinstance(next_payload.get("themes"), list) else []:
        if not isinstance(theme, dict):
            continue
        theme_name = str(theme.get("themeName") or theme.get("theme") or theme.get("name") or "").strip()
        normalized_name = _normalize_theme_lookup_name(theme_name)
        if not normalized_name:
            continue
        next_theme = dict(theme)
        next_theme["themeName"] = theme_name
        if not isinstance(next_theme.get("words"), list):
            next_theme["words"] = []
        index_by_name[normalized_name] = len(merged_themes)
        merged_themes.append(next_theme)

    for existing_theme in existing_payload.get("themes", []) if isinstance(existing_payload.get("themes"), list) else []:
        if not isinstance(existing_theme, dict):
            continue
        theme_name = str(existing_theme.get("themeName") or existing_theme.get("theme") or existing_theme.get("name") or "").strip()
        normalized_name = _normalize_theme_lookup_name(theme_name)
        if not normalized_name or normalized_name in deleted_theme_names:
            continue

        deleted_word_keys = deleted_word_keys_by_theme.get(normalized_name, set())
        manual_words = []
        for word in existing_theme.get("words", []) if isinstance(existing_theme.get("words"), list) else []:
            if not _theme_entry_is_manual(word):
                continue
            identity_key = _build_theme_word_identity_key(word)
            if identity_key and identity_key in deleted_word_keys:
                continue
            manual_words.append(word)

        preserve_theme_record = _selected_theme_record_is_manual(existing_theme, output_names, manual_output_names)
        if not manual_words and not preserve_theme_record:
            continue

        preserved_theme = dict(existing_theme)
        preserved_theme["themeName"] = theme_name
        preserved_theme["words"] = manual_words if isinstance(existing_theme.get("words"), list) else []
        if _theme_entry_is_manual(existing_theme):
            preserved_theme.setdefault("codeSource", existing_theme.get("codeSource") or "manual")
            preserved_theme.setdefault("source", existing_theme.get("source") or preserved_theme.get("codeSource") or "manual")
            preserved_theme.setdefault("ai_generated", False)
            preserved_theme.setdefault("humanTagged", True)

        existing_index = index_by_name.get(normalized_name)
        if existing_index is None:
            index_by_name[normalized_name] = len(merged_themes)
            merged_themes.append(preserved_theme)
            continue

        merged_themes[existing_index] = _merge_selected_theme_records(
            merged_themes[existing_index],
            preserved_theme,
        )

    merged_payload["themes"] = merged_themes
    return _canonicalize_selected_theme_payload(merged_payload)


def _visualization_theme_payload(mode: str | None = None, project_id: str | None = None, require_applied_selection: bool = False) -> dict:
    resolved_mode = mode or (session.get("mode", "user") if has_request_context() else "user")
    output_dir = _selected_themes_output_dir(mode=resolved_mode, project_id=project_id)
    selected_payload = _load_selected_theme_payload(output_dir)
    output_path = os.path.join(output_dir, "ai_generated.json")
    if not _json_file_has_content(output_path):
        if require_applied_selection:
            if _theme_payload_is_matching_excerpt_mode(selected_payload):
                matching_payload = _matching_excerpt_visualization_payload(selected_payload)
                return _final_visualization_display_payload(matching_payload)
            if _theme_payload_applied_to_visualization(selected_payload):
                return _final_visualization_display_payload(selected_payload)
            if _theme_payload_is_matching_excerpt_selection(selected_payload):
                return _final_visualization_display_payload(_matching_excerpt_visualization_payload(selected_payload))
            return _neutral_visualization_preview_payload()
        return selected_payload

    selected_payload = _filter_unmarked_generated_only_theme_pollution(selected_payload, output_path)
    generated_payload = build_theme_object_from_output(output_path, prefer_selected=False)
    if _has_selected_theme_state(selected_payload):
        if require_applied_selection:
            if _theme_payload_is_matching_excerpt_mode(selected_payload):
                matching_payload = _matching_excerpt_visualization_payload(selected_payload)
                return _final_visualization_display_payload(matching_payload)
            if _theme_payload_applied_to_visualization(selected_payload):
                return _final_visualization_display_payload(selected_payload)
            if _theme_payload_is_matching_excerpt_selection(selected_payload):
                return _final_visualization_display_payload(_matching_excerpt_visualization_payload(selected_payload))
            return _neutral_visualization_preview_payload()
        return selected_payload

    if require_applied_selection:
        return _neutral_visualization_preview_payload()

    manual_payload = _manual_theme_payload_from_output(output_path)
    if _has_theme_payload(manual_payload):
        return _merge_theme_payloads_preserving_manual(
            manual_payload,
            generated_payload,
            include_generated_only=True,
        )

    if _has_theme_payload(generated_payload):
        return generated_payload
    return {"themes": []}


def _clear_selected_theme_snapshot_for_generation(mode: str | None = None, project_id: str | None = None):
    resolved_mode = mode or (session.get("mode", "user") if has_request_context() else "user")
    output_dir = _selected_themes_output_dir(mode=resolved_mode, project_id=project_id)
    selected_path = os.path.join(output_dir, "SelectedThemes.json")
    existing_selected_payload = _load_json_payload_if_exists(selected_path, {"themes": []})
    preserved_opt_outs = (
        _normalize_manual_selection_opt_outs(existing_selected_payload)
        if isinstance(existing_selected_payload, dict) and "manualSelectionOptOuts" in existing_selected_payload
        else None
    )
    preserved_archived_codes = (
        _canonicalize_selected_theme_records(existing_selected_payload.get("archivedCodes"))
        if isinstance(existing_selected_payload, dict) and "archivedCodes" in existing_selected_payload
        else None
    )
    for filename in ("SelectedThemes.json", "deletedQuotes.json"):
        path = os.path.join(output_dir, filename)
        try:
            if os.path.exists(path):
                os.remove(path)
        except Exception as e:
            print(f"[WARN] Could not clear stale {filename} before generation: {e}")

    if preserved_opt_outs is not None or preserved_archived_codes is not None:
        preserved_payload = {"themes": []}
        if preserved_opt_outs is not None:
            preserved_payload["manualSelectionOptOuts"] = preserved_opt_outs
        if preserved_archived_codes is not None:
            preserved_payload["archivedCodes"] = preserved_archived_codes
        os.makedirs(output_dir, exist_ok=True)
        with open(selected_path, "w", encoding="utf-8") as f:
            json.dump(preserved_payload, f, indent=2, ensure_ascii=False)

    if has_request_context() and _safe_project_id(project_id) == _safe_project_id(session.get("current_project_id")):
        session["themeObject"] = preserved_payload if preserved_opt_outs is not None or preserved_archived_codes is not None else {"themes": []}


def _selected_themes_file_exists(output_dir: str | None) -> bool:
    if not output_dir:
        return False
    return os.path.exists(os.path.join(output_dir, "SelectedThemes.json"))


def _theme_object_for_transcript_mode(mode: str | None, project_id: str | None = None) -> dict:
    resolved_mode = mode or "user"
    if resolved_mode == "demo":
        ensure_demo_assets()
        _ensure_demo_visualization_seed(project_id)
        output_dir = get_demo_project_outputs_dir(project_id)
        if _selected_themes_file_exists(output_dir):
            return _load_selected_theme_payload(output_dir)

        session_theme_object = session.get("themeObject", {}) or {}
        if _has_selected_theme_state(session_theme_object) and not _session_theme_object_is_summary(session_theme_object):
            return session_theme_object
        return build_theme_object_from_output(get_demo_output_json_path(project_id))

    output_dir = get_user_project_processed_dir(project_id)
    selected_theme_payload = _load_selected_theme_payload(output_dir)
    output_path = os.path.join(output_dir, "ai_generated.json")
    if _json_file_has_content(output_path):
        generated_payload = build_theme_object_from_output(output_path, prefer_selected=False)
        if _has_selected_theme_state(selected_theme_payload):
            return _merge_theme_payloads_preserving_manual(
                _merge_generated_quotes_into_theme_payload(selected_theme_payload, output_dir),
                generated_payload,
                include_generated_only=True,
            )
        return generated_payload

    if _has_selected_theme_state(selected_theme_payload):
        return selected_theme_payload

    session_theme_object = session.get("themeObject", {}) or {}
    if _has_theme_payload(session_theme_object) and not _session_theme_object_is_summary(session_theme_object):
        return session_theme_object

    if _project_theme_generation_running("user", project_id):
        return {"themes": []}

    return selected_theme_payload


def _strip_theme_payload_words(theme_payload) -> dict:
    if not isinstance(theme_payload, dict) or not isinstance(theme_payload.get("themes"), list):
        return {"themes": []}

    stripped_themes = []
    for raw_theme in theme_payload.get("themes", []):
        if not isinstance(raw_theme, dict):
            continue

        theme_name = str(raw_theme.get("themeName") or raw_theme.get("theme") or raw_theme.get("name") or "").strip()
        if not theme_name:
            continue

        stripped_theme = dict(raw_theme)
        stripped_theme["themeName"] = theme_name
        stripped_theme["words"] = []
        if "color" not in stripped_theme:
            stripped_theme["color"] = ""
        if not isinstance(stripped_theme.get("groups"), list):
            stripped_theme["groups"] = []
        stripped_themes.append(stripped_theme)

    return {"themes": stripped_themes}


def _session_theme_object_is_summary(theme_payload) -> bool:
    return isinstance(theme_payload, dict) and theme_payload.get("_sessionSummaryOnly") is True


def _session_safe_theme_payload(theme_payload) -> dict:
    if not isinstance(theme_payload, dict):
        return {"themes": []}

    safe_payload = {
        key: value
        for key, value in theme_payload.items()
        if key not in {"themes", "projectId", "project_id"}
        and isinstance(value, (str, int, float, bool, type(None)))
    }
    safe_payload["_sessionSummaryOnly"] = True
    safe_payload["themes"] = []

    word_count = 0
    for raw_theme in theme_payload.get("themes", []) if isinstance(theme_payload.get("themes"), list) else []:
        if not isinstance(raw_theme, dict):
            continue

        theme_name = str(raw_theme.get("themeName") or raw_theme.get("theme") or raw_theme.get("name") or "").strip()
        if not theme_name:
            continue

        words = raw_theme.get("words")
        if isinstance(words, list):
            word_count += len(words)

        safe_theme = {
            "themeName": theme_name,
            "color": str(raw_theme.get("color") or "")[:64],
            "groups": list(raw_theme.get("groups", [])) if isinstance(raw_theme.get("groups"), list) else [],
        }
        summary = str(raw_theme.get("summary") or "").strip()
        if summary and SESSION_THEME_SUMMARY_TEXT_LIMIT > 0:
            safe_theme["summary"] = summary[:SESSION_THEME_SUMMARY_TEXT_LIMIT]
        safe_payload["themes"].append(safe_theme)

    safe_payload["_sessionThemeCount"] = len(safe_payload["themes"])
    safe_payload["_sessionWordCount"] = word_count
    return safe_payload


def _store_theme_object_in_session(theme_payload, project_id: str | None = None):
    if not has_request_context():
        return
    session["themeObject"] = _session_safe_theme_payload(theme_payload)
    session["themeObjectProjectId"] = _safe_project_id(project_id or session.get("current_project_id"))


def _compact_project_session_payloads():
    if not has_request_context():
        return

    theme_payload = session.get("themeObject")
    if isinstance(theme_payload, dict) and not _session_theme_object_is_summary(theme_payload):
        _store_theme_object_in_session(theme_payload, session.get("current_project_id"))


def _processed_transcripts_url_for_mode(mode: str | None = None, project_id: str | None = None) -> str:
    resolved_mode = mode or (session.get("mode", "user") if has_request_context() else "user")
    resolved_project_id = _safe_project_id(project_id or (session.get("current_project_id") if has_request_context() else None))
    return url_for("api_processed_transcripts_file", projectId=resolved_project_id, mode=resolved_mode)

def load_actual_output_data():
    actual_output_path = get_user_output_json_path()
    if os.path.exists(actual_output_path):
        try:
            with open(actual_output_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, dict) and len(data) > 0:
                return data
        except Exception as e:
            print(f"[WARN] Could not read actual ai_generated.json: {e}")
    return normalize_output_data(DEMO_OUTPUT_DATA)


def normalize_output_data(data):
    if isinstance(data, dict):
        return data
    if isinstance(data, list):
        normalized = {}
        for entry in data:
            if not isinstance(entry, dict):
                continue
            title = entry.get("title") or entry.get("themeName") or entry.get("theme") or entry.get("name")
            if not isinstance(title, str) or not title.strip():
                continue
            normalized[title] = {
                "summary": entry.get("summary", ""),
                "quotes": entry.get("quotes", []) or []
            }
        return normalized
    return {}


def pick_demo_audio_filename(participant: str) -> str:
    candidates = [
        f"{participant}_trimmed.m4a",
        f"{participant}.m4a",
        f"{participant}_trimmed.wav",
        f"{participant}.wav",
    ]
    os.makedirs(DEMO_AUDIO_DIR, exist_ok=True)
    search_dirs: list[str] = [DEMO_AUDIO_DIR, DEMO_RUNTIME_AUDIO_DIR]
    unique_search_dirs: list[str] = []
    for directory in search_dirs:
        if directory and (directory not in unique_search_dirs):
            unique_search_dirs.append(directory)

    for filename in candidates:
        demo_path = os.path.join(DEMO_AUDIO_DIR, filename)
        for source_dir in unique_search_dirs:
            source_path = os.path.join(source_dir, filename)
            if not os.path.exists(source_path):
                continue
            if source_dir != DEMO_AUDIO_DIR and not os.path.exists(demo_path):
                try:
                    shutil.copy2(source_path, demo_path)
                except Exception as e:
                    print(f"[WARN] Could not normalize demo audio {filename} into demo assets: {e}")
            return filename

    fallback_name = f"{participant}.wav"
    fallback_path = os.path.join(DEMO_AUDIO_DIR, fallback_name)
    if not os.path.exists(fallback_path):
        create_silent_wav(fallback_path)
    return fallback_name


def get_session_storage_dir(project_id: str | None = None, session_id: str | None = None, create: bool = True):
    ensure_user_session_context()
    resolved_session_id = _safe_session_id(session_id)
    if not resolved_session_id:
        return None
    return get_user_project_session_data_dir(project_id, resolved_session_id, create=create)


def _load_filemap_payload(path: str | None) -> dict | None:
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            payload = json.load(f)
        return payload if isinstance(payload, dict) else None
    except Exception as e:
        print(f"[WARN] Could not read filemap {path}: {e}")
        return None


def _seed_empty_filemap_for_project(project_id: str | None = None, session_id: str | None = None) -> str | None:
    session_dir = get_session_storage_dir(project_id, session_id)
    if not session_dir:
        return None

    filemap_path = os.path.join(session_dir, "filemap.json")
    payload = {"participants": []}
    try:
        os.makedirs(os.path.dirname(filemap_path), exist_ok=True)
        with open(filemap_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
    except Exception as e:
        print(f"[WARN] Could not seed empty filemap for {_safe_project_id(project_id)}: {e}")
        return None
    return filemap_path


def _filemap_participant_count(path: str | None) -> int:
    payload = _load_filemap_payload(path)
    participants = payload.get("participants") if isinstance(payload, dict) else None
    return len(participants) if isinstance(participants, list) else 0


def _candidate_filemap_paths_for_project(project_id: str | None = None) -> list[str]:
    safe_project_id = _safe_project_id(project_id)
    candidate_paths: list[str] = []

    resolved_session_id = _safe_session_id()
    current_session_dir = get_session_storage_dir(safe_project_id, resolved_session_id, create=False)
    if current_session_dir:
        candidate_paths.append(os.path.join(current_session_dir, "filemap.json"))

    project_session_root = get_user_project_session_data_root(safe_project_id, create=False)
    if os.path.isdir(project_session_root):
        try:
            for entry in os.scandir(project_session_root):
                if not entry.is_dir():
                    continue
                candidate_paths.append(os.path.join(entry.path, "filemap.json"))
        except OSError as e:
            print(f"[WARN] Could not scan project session data for {safe_project_id}: {e}")

    if os.path.isdir(SESSION_DATA_DIR) and not ((has_request_context() and session.get("user_workspace_key")) or _thread_workspace_key()):
        legacy_name = f"filemap_{safe_project_id}.json"
        try:
            for entry in os.scandir(SESSION_DATA_DIR):
                if not entry.is_dir():
                    continue
                candidate_paths.append(os.path.join(entry.path, legacy_name))
        except OSError as e:
            print(f"[WARN] Could not scan legacy session data for {safe_project_id}: {e}")

    unique_paths: list[str] = []
    seen_paths = set()
    for path in candidate_paths:
        normalized = os.path.normpath(path)
        if normalized in seen_paths:
            continue
        seen_paths.add(normalized)
        unique_paths.append(path)
    return unique_paths


def _best_existing_filemap_path_for_project(project_id: str | None = None) -> str | None:
    scored_candidates: list[tuple[int, int, float, str]] = []
    for path in _candidate_filemap_paths_for_project(project_id):
        if not os.path.exists(path):
            continue
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            mtime = 0.0
        participant_count = _filemap_participant_count(path)
        scored_candidates.append((1 if participant_count > 0 else 0, participant_count, mtime, path))

    if not scored_candidates:
        return None

    scored_candidates.sort(reverse=True)
    return scored_candidates[0][3]


def get_filemap_path_for_project(project_id: str | None = None):
    safe_project_id = _safe_project_id(project_id)
    resolved_session_id = _safe_session_id()
    session_dir = get_session_storage_dir(safe_project_id, resolved_session_id)
    if not session_dir:
        return None
    new_filemap_path = os.path.join(session_dir, "filemap.json")

    if _load_filemap_payload(new_filemap_path) is not None:
        return new_filemap_path

    if _project_awaits_first_upload(safe_project_id):
        return _seed_empty_filemap_for_project(safe_project_id, resolved_session_id) or new_filemap_path

    legacy_filemap_path = os.path.join(
        SESSION_DATA_DIR,
        resolved_session_id,
        f"filemap_{safe_project_id}.json"
    )
    if (not os.path.exists(new_filemap_path)) and os.path.exists(legacy_filemap_path):
        try:
            os.makedirs(os.path.dirname(new_filemap_path), exist_ok=True)
            shutil.copy2(legacy_filemap_path, new_filemap_path)
        except Exception as e:
            print(f"[WARN] Could not migrate legacy session filemap {legacy_filemap_path}: {e}")

    best_existing_path = _best_existing_filemap_path_for_project(safe_project_id)
    if best_existing_path and os.path.normpath(best_existing_path) != os.path.normpath(new_filemap_path):
        try:
            os.makedirs(os.path.dirname(new_filemap_path), exist_ok=True)
            shutil.copy2(best_existing_path, new_filemap_path)
        except Exception as e:
            print(f"[WARN] Could not restore filemap for project {safe_project_id} from {best_existing_path}: {e}")
            return best_existing_path

    if os.path.exists(new_filemap_path):
        return new_filemap_path
    if best_existing_path and os.path.exists(best_existing_path):
        return best_existing_path

    return new_filemap_path


def get_filemap_path():
    if has_request_context() and session.get("mode") == "demo":
        return get_filemap_path_for_project(_user_demo_project_id(session.get("current_project_id")))
    return get_filemap_path_for_project(session.get("current_project_id"))


def _sanitize_relative_path(path: str | None) -> str | None:
    raw_text = (path or "").strip()
    try:
        raw_text = unquote(raw_text)
    except Exception:
        pass
    text = raw_text.replace("\\", "/")
    if not text:
        return None
    text = re.sub(r"^https?://[^/]+/?", "", text, flags=re.IGNORECASE)
    text = text.split("?", 1)[0].split("#", 1)[0].strip().lstrip("/")
    if not text:
        return None
    if any(part in ("..", ".") for part in text.split("/")):
        return None
    return text


def _normalize_audio_relative_candidate(path: str | None) -> str:
    text = (path or "").strip().replace("\\", "/").lstrip("/")
    if not text:
        return ""

    for marker in (
        "/inputs/audio_storage/",
        "/uploads/audio_storage/",
        "/uploads/audio/",
        "/audio_storage/",
    ):
        if marker in text:
            text = text.split(marker, 1)[1]
            break

    prefixes = (
        "serve_audio/",
        "static/Uploaded_files/audio_storage/",
        "Uploaded_files/audio_storage/",
        "static/audio_storage/",
        "inputs/audio_storage/",
        "audio_storage/",
        "uploads/audio_storage/",
        "uploads/audio/",
    )
    changed = True
    while changed:
        changed = False
        for prefix in prefixes:
            if text.startswith(prefix):
                text = text[len(prefix):]
                changed = True

    return text.strip().lstrip("/")


def _resolve_transcript_path_for_mode(relative_path: str, mode: str, demo_project_dir: str | None = None) -> str | None:
    rel = _sanitize_relative_path(relative_path)
    if not rel:
        return None

    rel_variants: list[str] = []
    for candidate_rel in [rel, os.path.basename(rel)]:
        text = (candidate_rel or "").strip().replace("\\", "/")
        if not text:
            continue
        if text.startswith("uploads/transcripts/"):
            text = text[len("uploads/transcripts/"):]
        if text.startswith("uploads/"):
            text = text[len("uploads/"):]
        if text and text not in rel_variants:
            rel_variants.append(text)

    base_dirs: list[str] = []
    if mode == "demo":
        base_dirs.append(
            get_demo_project_uploads_dir(session.get("current_project_id") if has_request_context() else None)
        )
        if demo_project_dir:
            base_dirs.append(os.path.join(demo_project_dir, "uploads", "transcripts"))
        base_dirs.append(DEMO_TRANSCRIPTS_DIR)
        base_dirs.append(DEMO_RUNTIME_TRANSCRIPTS_DIR)
    else:
        base_dirs.append(get_user_project_uploads_dir())

    for base_dir in base_dirs:
        for rel_variant in rel_variants:
            candidate = os.path.join(base_dir, rel_variant)
            if os.path.exists(candidate):
                return candidate

    basename = os.path.basename(rel)
    if basename:
        for base_dir in base_dirs:
            for root, _, files in os.walk(base_dir):
                if basename in files:
                    return os.path.join(root, basename)
    return None


def _resolve_audio_path_for_mode(relative_path: str, mode: str, demo_project_dir: str | None = None) -> str | None:
    rel = _sanitize_relative_path(relative_path)
    if not rel:
        return None

    rel_variants: list[str] = []
    for candidate_rel in [rel, os.path.basename(rel)]:
        text = _normalize_audio_relative_candidate(candidate_rel)
        if not text:
            continue
        if text and text not in rel_variants:
            rel_variants.append(text)

    base_dirs: list[str] = []
    if mode == "demo":
        base_dirs.append(
            get_demo_project_audio_dir(session.get("current_project_id") if has_request_context() else None)
        )
        if demo_project_dir:
            base_dirs.append(os.path.join(demo_project_dir, "uploads", "audio"))
        base_dirs.append(DEMO_AUDIO_DIR)
        base_dirs.append(DEMO_RUNTIME_AUDIO_DIR)
    else:
        base_dirs.append(get_user_project_audio_dir())

    for base_dir in base_dirs:
        for rel_variant in rel_variants:
            candidate = os.path.join(base_dir, rel_variant)
            if os.path.exists(candidate):
                return candidate

    # Last-resort fallback for stale file maps that only keep basename and lose folders.
    basename = os.path.basename(rel)
    if basename:
        for base_dir in base_dirs:
            for root, _, files in os.walk(base_dir):
                if basename in files:
                    return os.path.join(root, basename)
    return None


def _audio_sources_fingerprint(audio_sources: list[dict]) -> str:
    payload = []
    for item in audio_sources:
        payload.append({
            "participant": item.get("participant"),
            "relativePath": item.get("relativePath"),
            "size": item.get("size"),
            "mtime": item.get("mtime"),
        })
    serialized = json.dumps(payload, sort_keys=True)
    return hashlib.sha1(serialized.encode("utf-8")).hexdigest()


app = Flask(__name__)
app.secret_key = settings.secret_key or secrets.token_hex(32)
app.permanent_session_lifetime = timedelta(days=31)
app.config["PREFERRED_URL_SCHEME"] = urlparse(_public_base_url()).scheme or "https"
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = os.environ.get("CHROMASCRIBE_SESSION_COOKIE_SAMESITE", "Lax")
session_cookie_secure = os.environ.get("CHROMASCRIBE_SESSION_COOKIE_SECURE")
if session_cookie_secure is not None:
    app.config["SESSION_COOKIE_SECURE"] = session_cookie_secure.strip().lower() in {"1", "true", "yes"}


@app.before_request
def prepare_local_workspace():
    error = local_request_error(request)
    if error:
        return jsonify({"error": error}), 403
    # Public assets need no session. Private project files still need workspace scope.
    if request.endpoint == "static" and not request.path.startswith("/static/User_projects/"):
        return None
    if request.endpoint is None:
        return None
    ensure_user_session_context()
    return None


@app.after_request
def compact_cookie_session_payloads(response):
    _compact_project_session_payloads()
    return response


def serve_static_asset(filename):
    directory = filename.split("/", 1)[0]
    if directory == "User_projects":
        if not is_local_session(session):
            return Response("Not found", status=404)
        ensure_user_session_context()
        relative_path = filename.partition("/")[2]
        file_path = project_storage.authorized_workspace_file(
            STATIC_DIR, relative_path, session.get("user_workspace_key", "")
        )
        if file_path is None:
            return Response("Not found", status=404)
        response = send_from_directory(str(file_path.parent), file_path.name)
        response.headers["Cache-Control"] = "private, no-store"
        return response
    if directory in project_storage.PRIVATE_STATIC_DIRECTORIES:
        return Response("Not found", status=404)
    return app.send_static_file(filename)


app.view_functions["static"] = serve_static_asset


@app.before_request
def route_demo_requests_with_prefix():
    path = _normalize_route_path(request.path)

    if is_demo_prefixed_path(path):
        _set_route_scope("demo")
        if "user" in session:
            ensure_user_session_context()
            ensure_demo_route_context(sync_assets=False)
        return None

    if request.endpoint == "static" or path.startswith("/static/") or path == "/favicon.ico":
        return None

    if not _is_demo_route_scope_active() or session.get("mode") != "demo":
        return None

    target_path = demo_prefixed_path(path)
    if target_path == path:
        return None

    query_string = request.query_string.decode("utf-8")
    target = f"{target_path}?{query_string}" if query_string else target_path
    redirect_code = 307 if request.method not in {"GET", "HEAD", "OPTIONS"} else 302
    return redirect(target, code=redirect_code)


@app.route('/api/processed_transcripts', methods=['GET'])
def api_processed_transcripts_file():
    ensure_user_session_context()
    mode = session.get('mode', 'user')
    project_id = _request_project_id(session.get("current_project_id"))
    if mode == 'demo':
        ensure_demo_assets()
        processed_path = get_demo_processed_transcripts_path(project_id)
    else:
        processed_path = get_user_processed_transcripts_path(project_id)

    if not _json_file_has_content(processed_path):
        return jsonify({"error": "Processed transcripts were not found for this project."}), 404
    try:
        with open(processed_path, "r", encoding="utf-8") as f:
            payload = json.load(f)
        return jsonify(payload), 200
    except Exception as e:
        return jsonify({"error": "Could not load processed transcripts.", "details": str(e)}), 500


@app.context_processor
def inject_route_scope_context():
    use_demo_prefix = is_demo_prefixed_path()
    return {
        "route_prefix": DEMO_ROUTE_PREFIX if use_demo_prefix else "",
        "route_path": lambda path: scoped_route_path(path, force_demo=use_demo_prefix),
    }


# --- Configuration for storage ---
APP_ROOT = os.path.dirname(os.path.abspath(__file__))
# Compatibility name for runtime paths; Flask's public assets use app.static_folder.
STATIC_DIR = os.path.join(DATA_DIR, 'static')
TRANSCRIPTS_STORAGE_DIR = os.path.join(STATIC_DIR, 'Uploaded_files', 'uploads')

os.makedirs(TRANSCRIPTS_STORAGE_DIR, exist_ok=True)
print(f"--- Transcripts will be physically stored in: {TRANSCRIPTS_STORAGE_DIR} ---")

DEMOGRAPHICS_JSON_DIR = os.path.join(STATIC_DIR, 'Processed_files', 'DemoJsons', 'demographics_data')
DEMO_ASSETS_DIR = os.path.join(STATIC_DIR, 'Demo_project')
os.makedirs(DEMOGRAPHICS_JSON_DIR, exist_ok=True)
print(f"--- Demographics JSON will be stored in: {DEMOGRAPHICS_JSON_DIR} ---")

DEMO_TRANSCRIPTS_DIR = os.path.join(DEMO_ASSETS_DIR, 'DataFiles')
DEMO_AUDIO_DIR = os.path.join(DEMO_ASSETS_DIR, 'audio')
DEMO_RUNTIME_DIR = os.path.join(DEMO_ASSETS_DIR, 'runtime')
DEMO_RUNTIME_TRANSCRIPTS_DIR = os.path.join(DEMO_RUNTIME_DIR, 'uploads')
DEMO_RUNTIME_AUDIO_DIR = os.path.join(DEMO_RUNTIME_DIR, 'audio_storage')
DEMO_RUNTIME_QUESTIONS_DIR = os.path.join(DEMO_RUNTIME_DIR, 'Questions')
DEMO_DEMOGRAPHICS_DIR = os.path.join(DEMO_ASSETS_DIR, 'DemoJsons', 'demographics_data')
DEMO_DEMOGRAPHICS_PATH = os.path.join(DEMO_DEMOGRAPHICS_DIR, 'DEMOGRAPHICS.json')
DEMO_ALL_TRANSCRIPTS_PATH = os.path.join(DEMO_ASSETS_DIR, 'all_transcripts_processed.json')
DEMO_QUESTIONS_PATH = os.path.join(DEMO_ASSETS_DIR, 'questions.json')
DEMO_OUTPUT_PATH = os.path.join(DEMO_ASSETS_DIR, 'ai_generated.json')
DEMO_NOTES_PATH = os.path.join(DEMO_ASSETS_DIR, 'notes.json')
os.makedirs(DEMO_RUNTIME_TRANSCRIPTS_DIR, exist_ok=True)
os.makedirs(DEMO_RUNTIME_AUDIO_DIR, exist_ok=True)
os.makedirs(DEMO_RUNTIME_QUESTIONS_DIR, exist_ok=True)

THEME_COLOR_PALETTE = ["#E7A23B", "#E14947", "#8EC053", "#579AE2", "#8E41D1"]
DEMO_SELECTED_THEME_LIMIT = 6
DEMO_SELECTION_SOURCE = "demo_preload"
DEMO_CODE_MANAGER_SEED_VERSION = "demo_code_manager_seed_v1"
DEMO_TRANSCRIPT_SEED_VERSION = "chromascribe_demo_seed_v2"

# The demo dialogue below is fictional, as confirmed by the project owner.
# It is provided for practice and is not participant research data.
DEMO_PROJECT_DEFS = [
    {
        "project_id": "project1",
        "project_name": "AI-Assisted QDA Demo",
        "participants": ["P3", "P6", "P7"],
        "themes": [
            {
                "title": "Researcher Control & Interpretive Depth",
                "summary": "Participants want AI assistance to speed up review while keeping interpretive control with the researcher.",
                "quotes": [
                    {"speaker": "P3", "text": "AI can help me organize the material, but I still need to decide what the quote means in context."},
                    {"speaker": "P6", "text": "I would use suggestions as a starting point, not as the final coding decision."}
                ],
            },
            {
                "title": "Visualization for Pattern Finding",
                "summary": "The timeline and participant-level views help researchers compare patterns across interviews.",
                "quotes": [
                    {"speaker": "P7", "text": "Seeing codes across participants helps me notice where a concern is isolated and where it repeats."}
                ],
            },
        ],
        "questions": [
            "How would you describe your overall reaction to using AI for qualitative analysis?",
            "Where did the tool help or slow down your coding workflow?",
            "What concerns would you have before using this with real participant data?",
            "How did the visualization affect your interpretation of the interviews?"
        ],
    },
    {
        "project_id": "project2",
        "project_name": "Project 2",
        "themes": [
            {
                "title": "Tagging Confidence",
                "summary": "Participants note when they felt confident tagging answers and codes.",
                "quotes": [
                    {"speaker": "Participant 7 A1", "text": "The tagging prompts made it easier to stay consistent."}
                ],
            },
            {
                "title": "Collaboration Needs",
                "summary": "Requests for sharing outputs and aligning across team members.",
                "quotes": [
                    {"speaker": "Participant 3 A1", "text": "Sharing a common codebook would help the team."}
                ],
            },
        ],
        "questions": [
            "How easy was it to tag answers?",
            "What would improve collaboration?",
            "Which outputs do you share most often?"
        ],
    },
    {
        "project_id": "project3",
        "project_name": "Project 3",
        "themes": [
            {
                "title": "Insights & Patterns",
                "summary": "Themes focus on spotting patterns across interviews quickly.",
                "quotes": [
                    {"speaker": "Participant 6 A1", "text": "Seeing the patterns helped me compare interviews fast."}
                ],
            },
            {
                "title": "Output Readiness",
                "summary": "Feedback on how ready the generated outputs are for reporting.",
                "quotes": [
                    {"speaker": "Participant 7 A1", "text": "The summaries were close to report-ready."}
                ],
            },
        ],
        "questions": [
            "Which insights stood out to you?",
            "How report-ready were the outputs?",
            "What would you refine before sharing?"
        ],
    },
]

DEFAULT_DEMO_PROJECT_ID = DEMO_PROJECT_DEFS[0]["project_id"]
USER_DEMO_PROJECT_PREFIX = "demo_project"

DEMO_OUTPUT_DATA = [
    {
        "title": "Researcher Control & Interpretive Depth",
        "summary": "Participants value AI support for organization, but they want final interpretive authority to remain with the researcher.",
        "quotes": [
            {"speaker": "P3", "text": "AI can help me organize the material, but I still need to decide what the quote means in context."},
            {"speaker": "P6", "text": "I would use suggestions as a starting point, not as the final coding decision."},
            {"speaker": "P7", "text": "The tool is useful when it keeps me close to the original excerpt instead of hiding the transcript behind a summary."}
        ]
    },
    {
        "title": "Efficiency in Early Coding",
        "summary": "AI-generated suggestions are useful for first-pass coding, clustering, and reducing repetitive review work.",
        "quotes": [
            {"speaker": "P3", "text": "The first pass is faster because I can review suggested codes instead of starting from an empty list."},
            {"speaker": "P6", "text": "For long interviews, this would save time by pointing me to places that deserve a closer read."},
            {"speaker": "P7", "text": "I liked having candidate excerpts ready, because it gave me something concrete to accept, reject, or rename."}
        ]
    },
    {
        "title": "Data Privacy & Consent",
        "summary": "Participants raise concerns about participant privacy, data governance, and transparency when AI processes interview data.",
        "quotes": [
            {"speaker": "P3", "text": "Before uploading transcripts, I would want to know exactly how participant data is stored and whether it is reused."},
            {"speaker": "P6", "text": "Consent matters here; the participant should understand that an AI system may assist with analysis."},
            {"speaker": "P7", "text": "I would need a clear data policy before using this on sensitive interviews."}
        ]
    },
    {
        "title": "Auditability & Transparency",
        "summary": "Users want visible evidence for AI suggestions so they can trace each code back to the source excerpt.",
        "quotes": [
            {"speaker": "P3", "text": "The confidence score is helpful, but I still need to see the exact excerpt before trusting the tag."},
            {"speaker": "P6", "text": "I want an audit trail that shows whether a code came from AI or from my manual decision."},
            {"speaker": "P7", "text": "The system should make it obvious when a quote is AI-tagged versus human-coded."}
        ]
    },
    {
        "title": "Visualization for Pattern Finding",
        "summary": "The visualization helps participants compare coding density, participant differences, and where themes appear over time.",
        "quotes": [
            {"speaker": "P3", "text": "Seeing the coded blocks on the timeline helps me check whether one participant is driving the theme."},
            {"speaker": "P6", "text": "The participant rows make comparison easier because I can see where a code appears without reading everything again."},
            {"speaker": "P7", "text": "I want more ways to visualize the data, because the overview can reveal patterns I might miss in a linear transcript."}
        ]
    },
    {
        "title": "Collaboration & Codebook Alignment",
        "summary": "Participants see value in shared codebooks, cleaner naming, and review workflows for team-based qualitative analysis.",
        "quotes": [
            {"speaker": "P3", "text": "If multiple researchers use the same project, the code manager should help us keep names consistent."},
            {"speaker": "P6", "text": "A shared codebook would make it easier to discuss disagreements and merge interpretations."},
            {"speaker": "P7", "text": "I would like to compare my codes with another researcher before treating the themes as final."}
        ]
    }
]

DEMO_CODE_MANAGER_DUMMY_CODES = [
    {
        "title": "Demo Needs Review",
        "summary": "A sample human-created code for practicing review, renaming, grouping, and removal workflows in Code Manager.",
        "color": "#F59F00",
        "groups": ["Demo exploration", "Review workflow"],
        "codeSource": "manual",
        "quotes": [
            {"speaker": "P3", "text": "The confidence score is helpful, but I still need to see the exact excerpt before trusting the tag."},
            {"speaker": "P7", "text": "The system should make it obvious when a quote is AI-tagged versus human-coded."}
        ],
    },
    {
        "title": "Demo Strong Evidence",
        "summary": "A sample code for marking excerpts that feel especially useful for a memo or presentation.",
        "color": "#0CA678",
        "groups": ["Demo exploration", "Evidence strength"],
        "codeSource": "manual",
        "quotes": [
            {"speaker": "P6", "text": "For long interviews, this would save time by pointing me to places that deserve a closer read."},
            {"speaker": "P7", "text": "I liked having candidate excerpts ready, because it gave me something concrete to accept, reject, or rename."}
        ],
    },
    {
        "title": "Demo Team Discussion",
        "summary": "A sample team-review code that demonstrates how shared codebook ideas can be explored before applying them to real data.",
        "color": "#1971C2",
        "groups": ["Demo exploration", "Collaboration"],
        "codeSource": "manual",
        "quotes": [
            {"speaker": "P3", "text": "If multiple researchers use the same project, the code manager should help us keep names consistent."},
            {"speaker": "P6", "text": "A shared codebook would make it easier to discuss disagreements and merge interpretations."}
        ],
    },
    {
        "title": "Demo Follow-up Question",
        "summary": "A placeholder code for excerpts that could become interview follow-up questions or analytic memos.",
        "color": "#C2255C",
        "groups": ["Demo exploration", "Memos"],
        "codeSource": "manual",
        "quotes": [
            {"speaker": "P3", "text": "Before uploading transcripts, I would want to know exactly how participant data is stored and whether it is reused."},
            {"speaker": "P7", "text": "I would need a clear data policy before using this on sensitive interviews."}
        ],
    },
]

# --- Storage for processed Question Sets (as text) ---
QUESTIONS_STORAGE_DIR = os.path.join(STATIC_DIR, 'Uploaded_files', 'Questions')
os.makedirs(QUESTIONS_STORAGE_DIR, exist_ok=True)
print(f"--- Question sets (as text) will be stored in: {QUESTIONS_STORAGE_DIR} ---")

os.makedirs(STATIC_DIR, exist_ok=True)

PROCESSED_FILES_DIR = os.path.join(STATIC_DIR, 'Processed_files')
os.makedirs(PROCESSED_FILES_DIR, exist_ok=True)

SESSION_DATA_DIR = os.path.join(DATA_DIR, 'projects', 'session_data')
os.makedirs(SESSION_DATA_DIR, exist_ok=True)

AUDIO_STORAGE_DIR = os.path.join(STATIC_DIR, 'Uploaded_files', 'audio_storage') # <-- NEW
os.makedirs(AUDIO_STORAGE_DIR, exist_ok=True)
print(f"--- Audio files will be stored in: {AUDIO_STORAGE_DIR} ---")

NON_VERBAL_CUES_FILENAME = "non_verbal_audio_cues.json"
NON_VERBAL_CUES_CACHE_VERSION = 1


def _is_non_verbal_cache_payload(payload) -> bool:
    if not isinstance(payload, dict):
        return False
    participants_payload = payload.get("participants")
    if not isinstance(participants_payload, dict):
        return False
    return len(participants_payload) > 0


def _load_non_verbal_cache_payload(cache_path: str | None):
    if not cache_path or not os.path.exists(cache_path):
        return None
    try:
        with open(cache_path, "r", encoding="utf-8") as f:
            payload = json.load(f) or {}
        if _is_non_verbal_cache_payload(payload):
            return payload
    except Exception:
        return None
    return None


def _demo_non_verbal_seed_paths(project_id: str | None = None) -> list[str]:
    return [os.path.join(DEMO_ASSETS_DIR, NON_VERBAL_CUES_FILENAME)]


def _load_demo_non_verbal_seed_payload(project_id: str | None = None):
    seen_paths = set()
    for candidate_path in _demo_non_verbal_seed_paths(project_id):
        if not candidate_path or candidate_path in seen_paths:
            continue
        seen_paths.add(candidate_path)
        payload = _load_non_verbal_cache_payload(candidate_path)
        if payload is not None:
            return payload
    return None


def _prepare_demo_non_verbal_payload(seed_payload: dict, project_id: str | None, source_fingerprint: str = ""):
    try:
        payload = json.loads(json.dumps(seed_payload))
    except Exception:
        payload = dict(seed_payload or {})

    payload["cacheVersion"] = NON_VERBAL_CUES_CACHE_VERSION
    payload["mode"] = "demo"
    payload["projectId"] = project_id
    payload["generatedAt"] = int(time.time())
    payload["sourceFingerprint"] = source_fingerprint or str(payload.get("sourceFingerprint") or "")
    if not isinstance(payload.get("errors"), list):
        payload["errors"] = []
    if "cached" not in payload:
        payload["cached"] = False
    return payload


def create_silent_wav(filepath: str, duration_sec: float = 1.0, sample_rate: int = 44100):
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    num_frames = int(duration_sec * sample_rate)
    with wave.open(filepath, 'w') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(b'\x00\x00' * num_frames)


def _output_payload_participants(output_data) -> set[str]:
    participants: set[str] = set()
    for _, theme_data in _output_theme_entries(normalize_output_data(output_data)):
        quotes = theme_data.get("quotes") if isinstance(theme_data, dict) else []
        if not isinstance(quotes, list):
            continue
        for quote in quotes:
            if not isinstance(quote, dict):
                continue
            participant = _normalize_theme_participant_code(quote.get("participant") or quote.get("speaker"))
            if participant:
                participants.add(participant.upper())
    return participants


def _demo_output_file_matches_seed(path: str, expected_payload) -> bool:
    existing_payload = _load_json_or_none(path)
    if not isinstance(existing_payload, (dict, list)):
        return False
    existing_output = normalize_output_data(existing_payload)
    expected_output = normalize_output_data(expected_payload)
    expected_titles = {str(title).strip() for title in expected_output.keys() if str(title).strip()}
    if expected_titles and not expected_titles.issubset(set(existing_output.keys())):
        return False
    expected_participants = _output_payload_participants(expected_output)
    if expected_participants and not expected_participants.issubset(_output_payload_participants(existing_output)):
        return False
    return bool(existing_output)


def _write_json_file(path: str, payload) -> bool:
    _atomic_write_json(path, payload)
    return True


def _write_demo_output_if_stale(path: str, output_source) -> bool:
    normalized_output = normalize_output_data(output_source)
    if _demo_output_file_matches_seed(path, normalized_output):
        return False
    return _write_json_file(path, normalized_output)


def _demo_transcript_probe_text() -> str:
    try:
        first_quote = DEMO_OUTPUT_DATA[0]["quotes"][0]["text"]
        return str(first_quote)[:80]
    except Exception:
        return "AI can help me organize"


def _format_demo_vtt_time(total_seconds: int) -> str:
    total_seconds = max(0, int(total_seconds or 0))
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    seconds = total_seconds % 60
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}.000"


def _parse_demo_timestamp_seconds(value: str | None) -> int:
    parts = str(value or "").strip().split(":")
    try:
        numbers = [int(float(part)) for part in parts if part != ""]
    except Exception:
        return 0
    if len(numbers) == 2:
        return numbers[0] * 60 + numbers[1]
    if len(numbers) == 3:
        return numbers[0] * 3600 + numbers[1] * 60 + numbers[2]
    return numbers[0] if numbers else 0


def _demo_processed_transcript_to_vtt(record: dict) -> str:
    entries = record.get("transcript") if isinstance(record, dict) else []
    lines = ["WEBVTT", "", f"NOTE {DEMO_TRANSCRIPT_SEED_VERSION}", ""]
    safe_entries = entries if isinstance(entries, list) else []
    for idx, entry in enumerate(safe_entries, start=1):
        if not isinstance(entry, dict):
            continue
        start = _parse_demo_timestamp_seconds(entry.get("timestamp"))
        script = re.sub(r"\s+", " ", str(entry.get("script") or "").strip())
        speaker = re.sub(r"\s+", " ", str(entry.get("speaker") or "").strip()) or "Speaker"
        if not script:
            continue
        duration = max(6, min(18, len(script) // 12 + 5))
        next_start = None
        for next_entry in safe_entries[idx:]:
            if not isinstance(next_entry, dict):
                continue
            candidate = _parse_demo_timestamp_seconds(next_entry.get("timestamp"))
            if candidate > start:
                next_start = candidate
                break
        if next_start is not None:
            duration = max(1, min(duration, next_start - start))
        lines.extend([
            str(idx),
            "",
            f"{_format_demo_vtt_time(start)} --> {_format_demo_vtt_time(start + duration)}",
            "",
            f"{speaker}: {script}",
            "",
        ])
    return "\n".join(lines).rstrip() + "\n"


def _write_demo_transcript_files(participants: list[str], processed_payload: dict, target_dir: str, force: bool = False) -> int:
    os.makedirs(target_dir, exist_ok=True)
    probe = _demo_transcript_probe_text()
    written = 0
    for participant in participants:
        participant_id = str(participant or "").strip()
        if not participant_id:
            continue
        filename = f"{participant_id}_Clean_Transcripts.txt"
        path = os.path.join(target_dir, filename)
        should_write = force or not os.path.exists(path)
        if not should_write and probe:
            try:
                with open(path, "r", encoding="utf-8") as f:
                    current_content = f.read()
                    should_write = probe not in current_content or DEMO_TRANSCRIPT_SEED_VERSION not in current_content
            except Exception:
                should_write = True
        if not should_write:
            continue
        record = processed_payload.get(filename) if isinstance(processed_payload, dict) else {}
        with open(path, "w", encoding="utf-8") as f:
            f.write(_demo_processed_transcript_to_vtt(record))
        written += 1
    return written


def ensure_demo_assets():
    os.makedirs(DEMO_TRANSCRIPTS_DIR, exist_ok=True)
    os.makedirs(DEMO_AUDIO_DIR, exist_ok=True)
    os.makedirs(DEMO_DEMOGRAPHICS_DIR, exist_ok=True)

    for participant in DEMO_PARTICIPANTS:
        pick_demo_audio_filename(participant)

    if not os.path.exists(DEMO_DEMOGRAPHICS_PATH):
        demo_demographics = {
            "P3": {"age": 40, "gender": "Female", "ethnicity": "White", "maritalStatus": "Married"},
            "P6": {"age": 35, "gender": "Male", "ethnicity": "African American", "maritalStatus": "Single"},
            "P7": {"age": 29, "gender": "Female", "ethnicity": "Asian", "maritalStatus": "Single"}
        }
        with open(DEMO_DEMOGRAPHICS_PATH, 'w', encoding='utf-8') as f:
            json.dump(demo_demographics, f, indent=2)

    normalized_output = normalize_output_data(DEMO_OUTPUT_DATA)
    output_rewritten = _write_demo_output_if_stale(DEMO_OUTPUT_PATH, normalized_output)

    default_questions = {
        "questions": DEMO_PROJECT_DEFS[0].get("questions", [])
    }
    existing_questions = _load_json_or_none(DEMO_QUESTIONS_PATH)
    expected_questions = default_questions.get("questions", [])
    existing_question_values = existing_questions.get("questions") if isinstance(existing_questions, dict) else []
    if not isinstance(existing_question_values, list) or expected_questions[:1] != existing_question_values[:1]:
        _write_json_file(DEMO_QUESTIONS_PATH, default_questions)

    if not os.path.exists(DEMO_NOTES_PATH):
        _write_json_file(DEMO_NOTES_PATH, {})

    demo_transcripts = build_demo_transcripts_for_participants(
        DEMO_PARTICIPANTS,
        output_data=normalized_output,
        questions=DEMO_PROJECT_DEFS[0].get("questions"),
    )
    if output_rewritten or not os.path.exists(DEMO_ALL_TRANSCRIPTS_PATH):
        _write_json_file(DEMO_ALL_TRANSCRIPTS_PATH, demo_transcripts)
    else:
        existing_processed = _load_json_or_none(DEMO_ALL_TRANSCRIPTS_PATH)
        expected_files = {f"{participant}_Clean_Transcripts.txt" for participant in DEMO_PARTICIPANTS}
        if not isinstance(existing_processed, dict) or not expected_files.issubset(set(existing_processed.keys())):
            _write_json_file(DEMO_ALL_TRANSCRIPTS_PATH, demo_transcripts)
            output_rewritten = True

    _write_demo_transcript_files(
        DEMO_PARTICIPANTS,
        demo_transcripts,
        DEMO_TRANSCRIPTS_DIR,
        force=output_rewritten,
    )

    demo_root_non_verbal_path = os.path.join(DEMO_ASSETS_DIR, NON_VERBAL_CUES_FILENAME)
    if not os.path.exists(demo_root_non_verbal_path):
        seed_payload = _load_demo_non_verbal_seed_payload(DEFAULT_DEMO_PROJECT_ID)
        if seed_payload is not None:
            try:
                prepared_payload = _prepare_demo_non_verbal_payload(
                    seed_payload,
                    DEFAULT_DEMO_PROJECT_ID
                )
                with open(demo_root_non_verbal_path, "w", encoding="utf-8") as f:
                    json.dump(prepared_payload, f, indent=2)
            except Exception as e:
                print(f"[WARN] Could not seed demo non-verbal cues cache in root assets: {e}")

    _ensure_demo_visualization_seed(DEFAULT_DEMO_PROJECT_ID, output_dir=DEMO_ASSETS_DIR, force=output_rewritten)


def _demo_created_at(index: int) -> str:
    month_day = str(index).rjust(2, "0")
    return f"2024-01-{month_day}T00:00:00+00:00"


def get_demo_project_dir(project_id: str | None):
    return None


def _user_demo_project_id(demo_project_id: str | None = None) -> str:
    resolved_demo_project_id = demo_project_id or DEFAULT_DEMO_PROJECT_ID
    for idx, project_def in enumerate(DEMO_PROJECT_DEFS, start=1):
        if project_def.get("project_id") == resolved_demo_project_id:
            return f"{USER_DEMO_PROJECT_PREFIX}_{idx}"
    return f"{USER_DEMO_PROJECT_PREFIX}_{_safe_project_id(resolved_demo_project_id)}"


def _demo_project_def_for_id(demo_project_id: str | None = None) -> dict | None:
    resolved_demo_project_id = demo_project_id or DEFAULT_DEMO_PROJECT_ID
    for project_def in DEMO_PROJECT_DEFS:
        if project_def.get("project_id") == resolved_demo_project_id:
            return project_def
    return None


def _is_demo_seed_project_id(project_id: str | None = None) -> bool:
    return _demo_project_def_for_id(project_id) is not None


def _copy_missing_file(src: str, dst: str) -> bool:
    if not src or not dst or not os.path.exists(src) or os.path.isdir(src):
        return False
    if os.path.exists(dst):
        return False
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)
    return True


def _copy_missing_tree(src_dir: str, dst_dir: str) -> int:
    copied = 0
    if not src_dir or not os.path.isdir(src_dir):
        return copied
    for current_root, _, filenames in os.walk(src_dir):
        rel_root = os.path.relpath(current_root, src_dir)
        target_root = dst_dir if rel_root == "." else os.path.join(dst_dir, rel_root)
        os.makedirs(target_root, exist_ok=True)
        for filename in filenames:
            if _copy_missing_file(
                os.path.join(current_root, filename),
                os.path.join(target_root, filename),
            ):
                copied += 1
    return copied


def _demo_project_name_for_user(demo_project_id: str | None, manifest: dict | None = None) -> str:
    resolved_demo_project_id = demo_project_id or DEFAULT_DEMO_PROJECT_ID
    if resolved_demo_project_id == DEFAULT_DEMO_PROJECT_ID:
        return "Demo project"
    source_name = str((manifest or {}).get("project_name") or "").strip()
    return f"Demo {source_name}" if source_name else f"Demo {resolved_demo_project_id}"


def _write_demo_seed_filemap_to_user_project(user_project_id: str, demo_project_id: str, participants: list[str]):
    normalized_participants = []
    for participant in participants:
        participant_id = str(participant or "").strip()
        if not participant_id:
            continue

        transcript_name = f"{participant_id}_Clean_Transcripts.txt"
        transcript_path = os.path.join(get_user_project_uploads_dir(user_project_id), transcript_name)
        audio_name = pick_demo_audio_filename(participant_id)
        audio_path = os.path.join(get_user_project_audio_dir(user_project_id), audio_name)

        normalized_participants.append({
            "participant": participant_id,
            "transcript": {
                "file": {},
                "id": f"demo-{demo_project_id}-{participant_id}-transcript",
                "type": "transcript",
                "serverTranscriptUrl": f"/serve_transcript/{transcript_name}",
                "originalFilename": transcript_name,
                "relativePath": transcript_name,
                "size": os.path.getsize(transcript_path) if os.path.exists(transcript_path) else None,
            },
            "audio": {
                "file": {},
                "id": f"demo-{demo_project_id}-{participant_id}-audio",
                "type": "audio",
                "serverTranscriptUrl": None,
                "originalFilename": audio_name,
                "relativePath": audio_name,
                "size": os.path.getsize(audio_path) if os.path.exists(audio_path) else None,
            }
        })

    target_filemap_path = os.path.join(get_session_storage_dir(user_project_id), "filemap.json")
    current_filemap = _load_filemap_payload(target_filemap_path)
    current_participants = current_filemap.get("participants") if isinstance(current_filemap, dict) else None
    if isinstance(current_participants, list) and current_participants:
        return target_filemap_path

    os.makedirs(os.path.dirname(target_filemap_path), exist_ok=True)
    with open(target_filemap_path, "w", encoding="utf-8") as f:
        json.dump({"participants": normalized_participants}, f, indent=2)
    return target_filemap_path


def _write_json_if_missing(path: str, payload) -> bool:
    if os.path.exists(path):
        return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    return True


def _write_text_if_missing(path: str, content: str) -> bool:
    if os.path.exists(path):
        return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return True


def _demo_output_source_for_project(demo_project_id: str | None = None):
    resolved_demo_project_id = demo_project_id or DEFAULT_DEMO_PROJECT_ID
    project_def = _demo_project_def_for_id(resolved_demo_project_id)
    if resolved_demo_project_id == DEFAULT_DEMO_PROJECT_ID:
        return DEMO_OUTPUT_DATA
    if project_def and project_def.get("themes"):
        return project_def.get("themes")
    return DEMO_OUTPUT_DATA


def _theme_payload_is_applied_selection(payload) -> bool:
    if not _has_selected_theme_state(payload):
        return False
    if payload.get("appliedToVisualization") is True:
        return True
    selection_stage = str(payload.get("selectionStage") or "").strip().lower()
    if selection_stage in {"applied_codes", "apply_codes", "visualization_applied"}:
        return True
    selection_source = str(payload.get("selectionSource") or "").strip().lower()
    return selection_source in {"applied_codes", "apply_codes", "manual_codes", "visualization_applied", DEMO_SELECTION_SOURCE}


def _build_demo_preloaded_selected_theme_payload(output_path: str) -> dict:
    generated_payload = build_theme_object_from_output(output_path, prefer_selected=False)
    generated_themes = generated_payload.get("themes") if isinstance(generated_payload, dict) else []
    if not isinstance(generated_themes, list):
        generated_themes = []

    selected_themes = []
    selected_names = set()
    for index, raw_theme in enumerate(generated_themes[:DEMO_SELECTED_THEME_LIMIT]):
        if not isinstance(raw_theme, dict):
            continue
        theme_name = str(raw_theme.get("themeName") or raw_theme.get("theme") or raw_theme.get("name") or "").strip()
        if not theme_name:
            continue
        selected_names.add(_normalize_theme_lookup_name(theme_name))

        words = []
        for raw_word in raw_theme.get("words", []) or []:
            entry = _build_theme_word_entry(raw_word)
            if not entry:
                continue
            entry.setdefault("codeSource", "ai")
            entry.setdefault("selectionSource", DEMO_SELECTION_SOURCE)
            entry["selectedByUser"] = True
            entry["aiTagged"] = True
            entry["ai_generated"] = True
            words.append(entry)

        selected_themes.append({
            "themeName": theme_name,
            "color": str(raw_theme.get("color") or THEME_COLOR_PALETTE[index % len(THEME_COLOR_PALETTE)]),
            "summary": str(raw_theme.get("summary") or "").strip(),
            "groups": list(raw_theme.get("groups", [])) if isinstance(raw_theme.get("groups"), list) else [],
            "words": words,
        })

    for offset, raw_code in enumerate(DEMO_CODE_MANAGER_DUMMY_CODES, start=len(selected_themes)):
        theme_name = str(raw_code.get("title") or raw_code.get("themeName") or "").strip()
        normalized_name = _normalize_theme_lookup_name(theme_name)
        if not theme_name or not normalized_name or normalized_name in selected_names:
            continue

        source_key = str(raw_code.get("codeSource") or "manual").strip().lower()
        is_manual = source_key in {"manual", "human", "human_manual_code", "manual_code"}
        words = []
        for raw_quote in raw_code.get("quotes", []) or []:
            entry = _build_theme_word_entry(raw_quote)
            if not entry:
                continue
            entry["codeSource"] = "manual" if is_manual else "ai"
            entry["source"] = entry["codeSource"]
            entry["selectionSource"] = DEMO_SELECTION_SOURCE
            entry["selectionStage"] = "applied_codes"
            entry["selectedByUser"] = True
            if is_manual:
                entry["humanTagged"] = True
                entry["ai_generated"] = False
            else:
                entry["aiTagged"] = True
                entry["ai_generated"] = True
            words.append(entry)

        selected_themes.append({
            "themeName": theme_name,
            "color": str(raw_code.get("color") or THEME_COLOR_PALETTE[offset % len(THEME_COLOR_PALETTE)]),
            "summary": str(raw_code.get("summary") or "").strip(),
            "groups": list(raw_code.get("groups", [])) if isinstance(raw_code.get("groups"), list) else [],
            "words": words,
            "selectionSource": DEMO_SELECTION_SOURCE,
            "selectionStage": "applied_codes",
        })
        selected_names.add(normalized_name)

    return {
        "themes": selected_themes,
        "appliedToVisualization": True,
        "selectionStage": "applied_codes",
        "selectionSource": DEMO_SELECTION_SOURCE,
        "visualizationPreviewState": "visualization_applied",
        "demoCodeManagerSeedVersion": DEMO_CODE_MANAGER_SEED_VERSION,
    }


def _ensure_demo_visualization_seed(
    demo_project_id: str | None = None,
    output_dir: str | None = None,
    output_source=None,
    force: bool = False,
) -> dict:
    resolved_demo_project_id = demo_project_id or DEFAULT_DEMO_PROJECT_ID
    resolved_output_dir = output_dir or get_demo_project_outputs_dir(resolved_demo_project_id)
    os.makedirs(resolved_output_dir, exist_ok=True)

    output_path = os.path.join(resolved_output_dir, "ai_generated.json")
    selected_path = os.path.join(resolved_output_dir, "SelectedThemes.json")
    existing_payload = {}
    if os.path.exists(selected_path):
        try:
            with open(selected_path, "r", encoding="utf-8") as f:
                existing_payload = json.load(f)
        except Exception as e:
            print(f"[WARN] Could not read existing demo SelectedThemes.json: {e}")
            existing_payload = {}

    # Both files contain user progress. Ordinary page/API reads must not replace
    # a changed code or removed excerpt with the original demo seed.
    if not force and os.path.isfile(output_path) and _theme_payload_is_applied_selection(existing_payload):
        return existing_payload

    seed_output = normalize_output_data(output_source or _demo_output_source_for_project(resolved_demo_project_id))
    if force or not _demo_output_file_matches_seed(output_path, seed_output):
        _write_json_file(output_path, seed_output)

    if _theme_payload_is_applied_selection(existing_payload):
        return existing_payload

    payload = _build_demo_preloaded_selected_theme_payload(output_path)
    if not _has_theme_payload(payload):
        return existing_payload if isinstance(existing_payload, dict) else {"themes": []}

    if isinstance(existing_payload, dict) and "manualSelectionOptOuts" in existing_payload:
        payload["manualSelectionOptOuts"] = _normalize_manual_selection_opt_outs(existing_payload)

    with open(selected_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)

    if has_request_context() and _safe_project_id(resolved_demo_project_id) == _safe_project_id(session.get("current_project_id")):
        _store_theme_object_in_session(payload, resolved_demo_project_id)
    return payload


def materialize_demo_project_for_current_user(demo_project_id: str | None = None) -> tuple[str, str]:
    ensure_user_session_context()
    ensure_demo_assets()

    resolved_demo_project_id = demo_project_id or DEFAULT_DEMO_PROJECT_ID
    project_def = _demo_project_def_for_id(resolved_demo_project_id)
    if not project_def:
        resolved_demo_project_id = DEFAULT_DEMO_PROJECT_ID
        project_def = _demo_project_def_for_id(resolved_demo_project_id)
    if not project_def:
        raise FileNotFoundError(f"Demo project '{resolved_demo_project_id}' was not found.")

    user_project_id = _user_demo_project_id(resolved_demo_project_id)
    existing_project_name = None
    for project in session.get("user_projects", []):
        if isinstance(project, dict) and _safe_project_id(project.get("projectId")) == user_project_id:
            existing_project_name = str(project.get("projectName") or "").strip() or None
            break
    user_project_name = existing_project_name or _demo_project_name_for_user(resolved_demo_project_id, project_def)

    uploads_dir = get_user_project_uploads_dir(user_project_id)
    audio_dir = get_user_project_audio_dir(user_project_id)
    questions_dir = get_user_project_questions_text_dir(user_project_id)
    outputs_dir = get_user_project_processed_dir(user_project_id)
    get_user_project_intermediate_dir(user_project_id)
    get_user_project_current_status_dir(user_project_id)

    participants = project_def.get("participants") or DEMO_PARTICIPANTS
    output_source = _demo_output_source_for_project(resolved_demo_project_id)
    output_data = normalize_output_data(output_source)
    demo_transcripts = build_demo_transcripts_for_participants(
        participants,
        output_data=output_source,
        questions=project_def.get("questions"),
    )
    demo_output_path = os.path.join(outputs_dir, "ai_generated.json")
    output_rewritten = False
    if not os.path.exists(demo_output_path):
        _write_json_file(demo_output_path, output_data)
        output_rewritten = True
    demo_transcript_probe = _demo_transcript_probe_text()

    for participant in participants:
        transcript_filename = f"{participant}_Clean_Transcripts.txt"
        transcript_target_path = os.path.join(uploads_dir, transcript_filename)
        refresh_transcript = output_rewritten or not os.path.exists(transcript_target_path)
        if not refresh_transcript and demo_transcript_probe:
            try:
                with open(transcript_target_path, "r", encoding="utf-8") as f:
                    current_transcript_text = f.read()
                    refresh_transcript = (
                        demo_transcript_probe not in current_transcript_text
                        or DEMO_TRANSCRIPT_SEED_VERSION not in current_transcript_text
                    )
            except Exception:
                refresh_transcript = True
        if refresh_transcript:
            record = demo_transcripts.get(transcript_filename) if isinstance(demo_transcripts, dict) else {}
            os.makedirs(os.path.dirname(transcript_target_path), exist_ok=True)
            with open(transcript_target_path, "w", encoding="utf-8") as f:
                f.write(_demo_processed_transcript_to_vtt(record))
        else:
            _copy_missing_file(
                os.path.join(DEMO_TRANSCRIPTS_DIR, transcript_filename),
                transcript_target_path,
            )
        audio_filename = pick_demo_audio_filename(participant)
        _copy_missing_file(
            os.path.join(DEMO_AUDIO_DIR, audio_filename),
            os.path.join(audio_dir, audio_filename),
        )

    source_questions_path = os.path.join(DEMO_ASSETS_DIR, "Questions", "newques.txt")
    if not _copy_missing_file(source_questions_path, os.path.join(questions_dir, "questions.txt")):
        question_lines = [
            f"{idx}. {question}"
            for idx, question in enumerate(project_def.get("questions", []), start=1)
        ]
        _write_text_if_missing(os.path.join(questions_dir, "questions.txt"), "\n".join(question_lines))

    questions_payload = {"questions": project_def.get("questions", [])}
    questions_json_path = os.path.join(outputs_dir, "questions.json")
    existing_questions_payload = _load_json_or_none(questions_json_path)
    existing_questions = (
        existing_questions_payload.get("questions")
        if isinstance(existing_questions_payload, dict)
        else None
    )
    # A saved list belongs to this user's demo workspace, including an empty
    # list after deletion. Seed only missing or malformed question data.
    if not isinstance(existing_questions, list):
        _write_json_file(questions_json_path, questions_payload)
    _write_json_if_missing(os.path.join(outputs_dir, "notes.json"), {})
    all_transcripts_path = os.path.join(outputs_dir, "all_transcripts_processed.json")
    if output_rewritten or not os.path.exists(all_transcripts_path):
        _write_json_file(all_transcripts_path, demo_transcripts)
    _ensure_demo_visualization_seed(
        resolved_demo_project_id,
        output_dir=outputs_dir,
        output_source=output_source,
        force=output_rewritten,
    )
    seed_non_verbal_payload = _load_demo_non_verbal_seed_payload(resolved_demo_project_id)
    if seed_non_verbal_payload is not None:
        non_verbal_payload = _prepare_demo_non_verbal_payload(seed_non_verbal_payload, user_project_id)
        non_verbal_payload["mode"] = "user"
        non_verbal_payload["projectId"] = user_project_id
        _write_json_if_missing(os.path.join(outputs_dir, NON_VERBAL_CUES_FILENAME), non_verbal_payload)

    demographics_output_dir = os.path.join(outputs_dir, "demographics")
    _copy_missing_file(DEMO_DEMOGRAPHICS_PATH, os.path.join(demographics_output_dir, "DEMOGRAPHICS.json"))
    _write_demo_seed_filemap_to_user_project(user_project_id, resolved_demo_project_id, participants)

    session["current_project_id"] = user_project_id
    session["current_project_name"] = user_project_name
    session["mode"] = "user"
    _set_route_scope("user")
    _record_user_project_name(user_project_id, user_project_name)
    _set_project_awaiting_first_upload(user_project_id, False)

    def mutator(meta: dict) -> bool:
        changed = False
        updates = {
            "source": "demo",
            "source_demo_project_id": resolved_demo_project_id,
            "source_demo_project_dir": _project_relative_storage_path(DEMO_ASSETS_DIR, APP_ROOT),
            "seeded_as_user_project": True,
        }
        for key, value in updates.items():
            if meta.get(key) != value:
                meta[key] = value
                changed = True
        return changed

    _update_project_meta(user_project_id, mutator)
    return user_project_id, user_project_name


def read_demo_project_manifest(project_dir: str):
    manifest_path = os.path.join(project_dir, "project.json")
    if not os.path.exists(manifest_path):
        return {}
    try:
        with open(manifest_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def build_demo_transcripts_for_participants(participants, output_data=None, questions=None):
    def format_timestamp(total_seconds: int) -> str:
        minutes = max(0, total_seconds) // 60
        seconds = max(0, total_seconds) % 60
        return f"{minutes:02d}:{seconds:02d}"

    if output_data is None:
        output_data = DEMO_OUTPUT_DATA
    quotes_by_participant = {participant: [] for participant in participants}
    if questions is None:
        questions = []
        if os.path.exists(DEMO_QUESTIONS_PATH):
            try:
                with open(DEMO_QUESTIONS_PATH, "r", encoding="utf-8") as f:
                    questions_payload = json.load(f)
                    questions = questions_payload.get("questions", []) if isinstance(questions_payload, dict) else []
            except Exception as e:
                print(f"[WARN] Could not read demo questions: {e}")
                questions = []
    if not questions:
        questions = [
            "Can you describe your experience with qualitative research?",
            "What tools do you use for analysis?",
            "What challenges do you face when interpreting transcripts?"
        ]

    def resolve_participant_id(speaker_label: str):
        if not speaker_label:
            return None
        upper = speaker_label.upper()
        direct_match = re.search(r'\bP(\d+)\b', upper)
        if direct_match:
            return f"P{direct_match.group(1)}"
        if upper.startswith("PARTICIPANT"):
            number_match = re.search(r'(\d+)', upper)
            if number_match:
                return f"P{number_match.group(1)}"
        return None

    theme_entries = []
    if isinstance(output_data, dict):
        theme_entries = list(output_data.values())
    elif isinstance(output_data, list):
        theme_entries = output_data

    for theme_data in theme_entries:
        if not isinstance(theme_data, dict):
            continue
        for quote in theme_data.get("quotes", []):
            if not isinstance(quote, dict):
                continue
            speaker = str(quote.get("speaker", "")).strip()
            text = str(quote.get("text", "")).strip()
            if not speaker or not text:
                continue
            matched_participant = resolve_participant_id(speaker) or speaker.upper().split()[0]
            matched_participant = matched_participant.upper() if matched_participant else ""
            for participant in participants:
                if matched_participant == participant.upper():
                    quotes_by_participant[participant].append(text)

    demo_transcripts = {}
    for participant in participants:
        transcript_filename = f"{participant}_Clean_Transcripts.txt"
        audio_filename = pick_demo_audio_filename(participant)

        transcript_entries = []
        timestamp = 0
        quotes = quotes_by_participant.get(participant, [])
        if not quotes:
            quotes = ["This is a placeholder response for the demo project."]
        for idx, quote_text in enumerate(quotes, start=1):
            question_index = ((idx - 1) % len(questions)) + 1
            question_text = questions[question_index - 1]
            transcript_entries.append({
                "speaker": "Interviewer",
                "timestamp": format_timestamp(timestamp),
                "script": question_text,
                "tag": f"Q{question_index}"
            })
            timestamp += 10
            transcript_entries.append({
                "speaker": participant,
                "timestamp": format_timestamp(timestamp),
                "script": quote_text,
                "tag": f"A{question_index}"
            })
            timestamp += 20

        demo_transcripts[transcript_filename] = {
            "date": "unknown",
            "audiofile": audio_filename,
            "transcript": transcript_entries
        }

    return demo_transcripts

def sync_demo_project_to_active_assets(project_id: str | None):
    ensure_demo_assets()
    project_dir = get_demo_project_dir(project_id) or get_demo_project_dir(DEFAULT_DEMO_PROJECT_ID)
    if not project_dir:
        return None

    outputs_dir = os.path.join(project_dir, "outputs")
    for filename in ("ai_generated.json", "questions.json", "all_transcripts_processed.json", "TagConflicts.json", "notes.json", NON_VERBAL_CUES_FILENAME):
        src = os.path.join(outputs_dir, filename)
        if os.path.exists(src):
            try:
                shutil.copy2(src, os.path.join(DEMO_ASSETS_DIR, filename))
            except Exception as e:
                print(f"[WARN] Could not sync demo output {filename}: {e}")

    demo_demographics_src = os.path.join(outputs_dir, "demographics", "DEMOGRAPHICS.json")
    if os.path.exists(demo_demographics_src):
        os.makedirs(DEMO_DEMOGRAPHICS_DIR, exist_ok=True)
        try:
            shutil.copy2(demo_demographics_src, DEMO_DEMOGRAPHICS_PATH)
        except Exception as e:
            print(f"[WARN] Could not sync demo demographics: {e}")

    uploads_transcripts = os.path.join(project_dir, "uploads", "transcripts")
    if os.path.exists(uploads_transcripts):
        os.makedirs(DEMO_RUNTIME_TRANSCRIPTS_DIR, exist_ok=True)
        for entry in os.listdir(uploads_transcripts):
            src = os.path.join(uploads_transcripts, entry)
            if os.path.isdir(src):
                continue
            try:
                shutil.copy2(src, os.path.join(DEMO_RUNTIME_TRANSCRIPTS_DIR, entry))
            except Exception as e:
                print(f"[WARN] Could not sync demo transcript {entry}: {e}")

    uploads_audio = os.path.join(project_dir, "uploads", "audio")
    if os.path.exists(uploads_audio):
        os.makedirs(DEMO_RUNTIME_AUDIO_DIR, exist_ok=True)
        for entry in os.listdir(uploads_audio):
            src = os.path.join(uploads_audio, entry)
            if os.path.isdir(src):
                continue
            try:
                shutil.copy2(src, os.path.join(DEMO_RUNTIME_AUDIO_DIR, entry))
            except Exception as e:
                print(f"[WARN] Could not sync demo audio {entry}: {e}")

    return project_dir


def resolve_demo_project_context(project_id: str | None = None) -> tuple[str, str]:
    ensure_demo_assets()
    candidate_project_id = project_id or session.get("current_project_id") or DEFAULT_DEMO_PROJECT_ID
    if not get_demo_project_dir(candidate_project_id) and not _demo_project_def_for_id(candidate_project_id):
        candidate_project_id = DEFAULT_DEMO_PROJECT_ID

    demo_project_dir = get_demo_project_dir(candidate_project_id)
    manifest = read_demo_project_manifest(demo_project_dir) if demo_project_dir else {}
    project_def = _demo_project_def_for_id(candidate_project_id) or DEMO_PROJECT_DEFS[0]
    resolved_project_id = manifest.get("project_id", candidate_project_id)
    resolved_project_name = manifest.get("project_name", project_def.get("project_name", "Project 1"))
    return resolved_project_id, resolved_project_name


def ensure_demo_route_context(project_id: str | None = None, sync_assets: bool = False):
    if not has_request_context():
        return

    resolved_project_id, resolved_project_name = resolve_demo_project_context(project_id)
    mode_changed = session.get("mode") != "demo"
    project_changed = session.get("current_project_id") != resolved_project_id

    if session.get("user"):
        try:
            materialize_demo_project_for_current_user(resolved_project_id)
        except Exception as e:
            print(f"[WARN] Could not prepare hidden demo workspace: {e}")

    set_current_project(resolved_project_id, resolved_project_name, "demo")
    _set_route_scope("demo")
    selected_payload = _ensure_demo_visualization_seed(resolved_project_id)

    if _has_selected_theme_state(selected_payload):
        _store_theme_object_in_session(selected_payload, resolved_project_id)
        return

    if sync_assets or mode_changed or project_changed:
        _store_theme_object_in_session(
            build_theme_object_from_output(get_demo_output_json_path(resolved_project_id)),
            resolved_project_id,
        )


#qwen model
def _themes_txt_path(project_id: str | None = None, mode: str | None = None, processed_dir: str | None = None) -> str:
  if processed_dir:
    return os.path.join(processed_dir, "themes.txt")
  resolved_mode = mode or (session.get("mode", "user") if has_request_context() else "user")
  if resolved_mode == "demo":
    return os.path.join(get_demo_project_outputs_dir(project_id), "themes.txt")
  if project_id or has_request_context():
    return os.path.join(get_user_project_processed_dir(project_id), "themes.txt")
  return "themes.txt"


def write_topics_qwen(topics, project_id: str | None = None, mode: str | None = None, processed_dir: str | None = None):
  themes_path = _themes_txt_path(project_id=project_id, mode=mode, processed_dir=processed_dir)
  os.makedirs(os.path.dirname(themes_path) or ".", exist_ok=True)
  words = []
  with open(themes_path, "w", encoding="utf-8") as file:
    for x in topics:
      file.write("{}\n".format(x))
      words.append(x)
  return words


def read_themes(project_id: str | None = None, mode: str | None = None, processed_dir: str | None = None):
  themes = []
  with open(_themes_txt_path(project_id=project_id, mode=mode, processed_dir=processed_dir), 'r', encoding="utf-8") as f:
    curtext = f.read()
    for line in curtext.split('\n'):
      if line is not None and line != '':
        themes.append(line)
  return themes

# Write topics info to csv files
def write_topics_info(topics_info):
  file = open("topics_info.csv", "w")
  topics_info.to_csv("topics_info.csv")
  file.write(topics_info)


def _candidate_intermediate_dirs_for_project(mode: str | None = None, project_id: str | None = None) -> list[str]:
    resolved_mode = mode or (session.get("mode", "user") if has_request_context() else "user")
    dirs = []
    if resolved_mode == "demo":
        try:
            dirs.append(get_user_project_intermediate_dir(_user_demo_project_id(project_id)))
        except Exception:
            pass
    else:
        try:
            dirs.append(get_user_project_intermediate_dir(project_id))
        except Exception:
            pass
    dirs.append(os.path.join(REPO_ROOT, "intermediate_files"))

    unique_dirs = []
    seen = set()
    for path in dirs:
        normalized = os.path.normpath(path)
        if normalized in seen:
            continue
        seen.add(normalized)
        unique_dirs.append(path)
    return unique_dirs


def _select_matching_intermediate_entry_map(payload, allowed_keys: set[str]) -> dict:
    if not isinstance(payload, dict):
        return {}
    if not allowed_keys:
        return payload

    matched = {}
    allowed_by_basename = {
        os.path.basename(str(key or "")).lower(): key
        for key in allowed_keys
    }

    for key, value in payload.items():
        if key in allowed_keys:
            matched[key] = value
            continue
        basename = os.path.basename(str(key or "")).lower()
        if basename in allowed_by_basename:
            matched[allowed_by_basename[basename]] = value

    return matched


@app.route('/api/project_qna_tag_payload', methods=['GET'])
def api_project_qna_tag_payload():
    ensure_user_session_context()

    mode = session.get("mode", "user")
    project_id = session.get("current_project_id")

    if mode == "demo":
        processed_path = get_demo_processed_transcripts_path(project_id)
    else:
        processed_path = get_user_processed_transcripts_path(project_id)

    processed_payload = _read_json_if_exists(processed_path)
    allowed_keys = set(processed_payload.keys()) if isinstance(processed_payload, dict) else set()

    selected_dir = ""
    questions_payload = {}
    answers_payload = {}
    possible_answers_payload = {}

    for candidate_dir in _candidate_intermediate_dirs_for_project(mode=mode, project_id=project_id):
        candidate_questions = _read_json_if_exists(os.path.join(candidate_dir, "questions_tagged.json"))
        candidate_answers = _read_json_if_exists(os.path.join(candidate_dir, "answers_tagged.json"))
        candidate_possible_answers = _read_json_if_exists(os.path.join(candidate_dir, "possible_answers_script.json"))

        filtered_questions = _select_matching_intermediate_entry_map(candidate_questions, allowed_keys)
        filtered_answers = _select_matching_intermediate_entry_map(candidate_answers, allowed_keys)
        filtered_possible_answers = _select_matching_intermediate_entry_map(candidate_possible_answers, allowed_keys)

        if filtered_questions or filtered_answers or filtered_possible_answers:
            selected_dir = candidate_dir
            questions_payload = filtered_questions
            answers_payload = filtered_answers
            possible_answers_payload = filtered_possible_answers
            break

    return jsonify({
        "questions": questions_payload,
        "answers": answers_payload,
        "possibleAnswers": possible_answers_payload,
        "sourceDir": selected_dir,
    }), 200


@app.route('/api/processed_transcripts_meta', methods=['GET'])
def api_processed_transcripts_meta():
    ensure_user_session_context()
    mode = session.get('mode', 'user')
    project_id = _request_project_id(session.get("current_project_id"))
    if mode == 'demo':
        ensure_demo_assets()
        target_path = get_demo_processed_transcripts_path(project_id)
    else:
        target_path = get_user_processed_transcripts_path(project_id)
    try:
        stat = os.stat(target_path)
        return jsonify({
            "exists": True,
            "mtime": int(stat.st_mtime),
            "size": stat.st_size,
            "mode": mode,
            "projectId": project_id
        })
    except FileNotFoundError:
        return jsonify({
            "exists": False,
            "mtime": None,
            "size": None,
            "mode": mode,
            "projectId": project_id
        })


def _empty_non_verbal_participant_payload(audio_relative_path: str | None = None, error_message: str | None = None):
    payload = {
        "audioRelativePath": audio_relative_path or "",
        "durationSec": 0.0,
        "segments": {"laughter": [], "long_silence": []},
        "summary": {
            "laughter": {"count": 0, "durationSec": 0.0, "percentOfAudio": 0.0, "segmentsPerMinute": 0.0},
            "long_silence": {"count": 0, "durationSec": 0.0, "percentOfAudio": 0.0, "segmentsPerMinute": 0.0},
            "cueCoveragePercent": 0.0,
        },
    }
    if error_message:
        payload["error"] = str(error_message)
    return payload


@app.route('/api/non_verbal_audio_cues', methods=['GET'])
def api_non_verbal_audio_cues():
    ensure_user_session_context()

    mode = session.get('mode', 'user')
    force_refresh = str(request.args.get("force", "0")).strip().lower() in {"1", "true", "yes"}
    project_id = session.get("current_project_id")
    demo_project_dir = None

    if mode == "demo":
        ensure_demo_assets()
        if not get_demo_project_dir(project_id) and not _demo_project_def_for_id(project_id):
            project_id = DEFAULT_DEMO_PROJECT_ID
        demo_project_dir = get_demo_project_dir(project_id)
        if demo_project_dir:
            sync_demo_project_to_active_assets(project_id)
        session['current_project_id'] = project_id

    response_payload = {
        "cacheVersion": NON_VERBAL_CUES_CACHE_VERSION,
        "mode": mode,
        "projectId": project_id,
        "generatedAt": int(time.time()),
        "sourceFingerprint": "",
        "cached": False,
        "participants": {},
        "errors": [],
    }

    if mode == "demo":
        if demo_project_dir:
            filemap_path = os.path.join(demo_project_dir, "filemap.json")
            cache_dir = os.path.join(demo_project_dir, "outputs")
        else:
            _ensure_demo_visualization_seed(project_id)
            filemap_path = get_filemap_path()
            cache_dir = get_demo_project_outputs_dir(project_id)
    else:
        filemap_path = get_filemap_path()
        cache_dir = get_user_project_processed_dir()

    cache_path = os.path.join(cache_dir, NON_VERBAL_CUES_FILENAME)

    if not filemap_path or not os.path.exists(filemap_path):
        response_payload["errors"].append("No file map found for this project.")
        return jsonify(response_payload), 200

    try:
        with open(filemap_path, "r", encoding="utf-8") as f:
            file_map = json.load(f) or {}
    except Exception as e:
        return jsonify({"error": f"Failed to read file map: {e}"}), 500

    participants = file_map.get("participants", [])
    if not isinstance(participants, list):
        participants = []
    if not participants:
        response_payload["errors"].append("No participants found in file map.")
        return jsonify(response_payload), 200

    audio_sources = []
    for entry in participants:
        participant_id = str((entry or {}).get("participant", "")).strip()
        if not participant_id:
            continue
        audio_relative_path = _sanitize_relative_path(((entry or {}).get("audio") or {}).get("relativePath"))
        if not audio_relative_path:
            response_payload["participants"][participant_id] = _empty_non_verbal_participant_payload(
                error_message="No audio file linked to participant."
            )
            continue

        resolved_audio_path = _resolve_audio_path_for_mode(audio_relative_path, mode, demo_project_dir=demo_project_dir)
        if not resolved_audio_path:
            response_payload["participants"][participant_id] = _empty_non_verbal_participant_payload(
                audio_relative_path=audio_relative_path,
                error_message="Audio file not found on server.",
            )
            continue

        try:
            stat = os.stat(resolved_audio_path)
        except OSError:
            response_payload["participants"][participant_id] = _empty_non_verbal_participant_payload(
                audio_relative_path=audio_relative_path,
                error_message="Audio file metadata unavailable.",
            )
            continue

        audio_sources.append({
            "participant": participant_id,
            "relativePath": audio_relative_path,
            "absolutePath": resolved_audio_path,
            "size": int(stat.st_size),
            "mtime": int(stat.st_mtime),
        })

    source_fingerprint = _audio_sources_fingerprint(audio_sources)
    response_payload["sourceFingerprint"] = source_fingerprint

    if (not force_refresh) and os.path.exists(cache_path):
        try:
            cached_payload = _load_non_verbal_cache_payload(cache_path)
            if mode == "demo" and cached_payload is not None:
                prepared_payload = _prepare_demo_non_verbal_payload(
                    cached_payload,
                    project_id,
                    source_fingerprint=source_fingerprint
                )
                prepared_payload["cached"] = True
                return jsonify(prepared_payload), 200
            if (
                cached_payload is not None
                and cached_payload.get("cacheVersion") == NON_VERBAL_CUES_CACHE_VERSION
                and cached_payload.get("sourceFingerprint") == source_fingerprint
            ):
                cached_payload["cached"] = True
                cached_payload["mode"] = mode
                cached_payload["projectId"] = project_id
                return jsonify(cached_payload), 200
        except Exception as cache_err:
            response_payload["errors"].append(f"Cache read skipped: {cache_err}")

    if mode == "demo" and (not force_refresh):
        demo_seed_payload = _load_demo_non_verbal_seed_payload(project_id)
        if demo_seed_payload is not None:
            prepared_payload = _prepare_demo_non_verbal_payload(
                demo_seed_payload,
                project_id,
                source_fingerprint=source_fingerprint
            )
            prepared_payload["cached"] = True
            os.makedirs(cache_dir, exist_ok=True)
            try:
                with open(cache_path, "w", encoding="utf-8") as f:
                    json.dump(prepared_payload, f, indent=2)
            except Exception as write_err:
                prepared_payload.setdefault("errors", []).append(f"Cache write skipped: {write_err}")
            return jsonify(prepared_payload), 200

    for source in audio_sources:
        participant_id = source["participant"]
        audio_relative_path = source["relativePath"]
        try:
            cues = detect_non_verbal_audio_cues(source["absolutePath"])
            response_payload["participants"][participant_id] = {
                "audioRelativePath": audio_relative_path,
                "durationSec": cues.get("durationSec", 0.0),
                "sampleRate": cues.get("sampleRate"),
                "segments": cues.get("segments", {"laughter": [], "long_silence": []}),
                "summary": cues.get("summary", {}),
                "thresholds": cues.get("thresholds", {}),
            }
        except Exception as detect_err:
            msg = f"{participant_id}: {detect_err}"
            response_payload["errors"].append(msg)
            response_payload["participants"][participant_id] = _empty_non_verbal_participant_payload(
                audio_relative_path=audio_relative_path,
                error_message=str(detect_err),
            )

    os.makedirs(cache_dir, exist_ok=True)
    response_payload["generatedAt"] = int(time.time())
    try:
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(response_payload, f, indent=2)
    except Exception as write_err:
        response_payload["errors"].append(f"Cache write skipped: {write_err}")

    return jsonify(response_payload), 200


@app.route('/api/session_context', methods=['GET'])
def session_context():
    ensure_user_session_context()
    context = get_project_context()
    context["username"] = session.get("user")
    context["userKey"] = session.get("user_key")
    context["workspaceKey"] = session.get("user_workspace_key")
    context["userIndex"] = session.get("user_index")
    context["publicBaseUrl"] = _public_base_url()
    context["localWorkspace"] = True
    if session.get("current_project_id") and _session_project_is_authorized(session.get("current_project_id")):
        context["projectRevision"] = _project_revision(session.get("current_project_id"))
    return jsonify(context), 200


def _browser_progress_path(mode: str, project_id: str) -> str:
    output_dir = (
        get_demo_project_outputs_dir(project_id)
        if mode == "demo"
        else get_user_project_processed_dir(project_id)
    )
    return os.path.join(output_dir, "browser_progress.json")


def _normalize_browser_progress_state(raw_state) -> dict[str, str]:
    if not isinstance(raw_state, dict):
        return {}
    normalized = {}
    total_size = 0
    for raw_key, raw_value in raw_state.items():
        key = str(raw_key or "").strip()
        if not key or len(key) > 240 or not isinstance(raw_value, str):
            continue
        encoded_size = len(key.encode("utf-8")) + len(raw_value.encode("utf-8"))
        if encoded_size > 512 * 1024 or total_size + encoded_size > 2 * 1024 * 1024:
            continue
        normalized[key] = raw_value
        total_size += encoded_size
    return normalized


@app.route('/api/project_progress_state', methods=['GET', 'POST'])
def project_progress_state():
    ensure_user_session_context()
    payload = request.get_json(silent=True) or {}
    project_id = _request_project_id(session.get("current_project_id"), payload)
    if not _session_project_is_authorized(project_id):
        return _project_not_found_response()
    mode = session.get("mode", "user")
    progress_path = _browser_progress_path(mode, project_id)

    if request.method == 'GET':
        with _project_mutation_lock(project_id):
            stored = _load_json_payload_if_exists(progress_path, {})
            if not isinstance(stored, dict):
                stored = {}
            response_payload = {
                "browserState": _normalize_browser_progress_state(stored.get("browserState")),
                "hasSavedState": os.path.exists(progress_path),
                "browserStateBaseRevision": stored.get("browserStateBaseRevision"),
                "browserStateRevision": stored.get("browserStateRevision"),
                "projectRevision": _project_revision(project_id),
            }
        return jsonify(response_payload), 200

    submitted_revision = payload.get("projectRevision")
    with _project_mutation_lock(project_id):
        current_revision = _project_revision(project_id)
        if submitted_revision is not None:
            try:
                submitted_revision = int(submitted_revision)
            except (TypeError, ValueError):
                return jsonify({"error": "Invalid project revision.", "projectRevision": current_revision}), 400
            if submitted_revision != current_revision:
                return jsonify({
                    "error": "Project changed in another tab or device. Reload before saving.",
                    "projectRevision": current_revision,
                }), 409
        browser_state = _normalize_browser_progress_state(payload.get("browserState"))
        # Record only the revision change caused by this browser-state save.
        # Later code or transcript edits must not make an older cache look current.
        _atomic_write_json(progress_path, {
            "browserState": browser_state,
            "savedAt": int(time.time()),
            "browserStateBaseRevision": current_revision,
            "browserStateRevision": current_revision + 1,
        })
        next_revision = _advance_project_revision(project_id)
    return jsonify({
        "ok": True,
        "browserStateBaseRevision": current_revision,
        "browserStateRevision": next_revision,
        "projectRevision": next_revision,
    }), 200


@app.route('/api/usage/log', methods=['POST'])
def api_usage_log():
    """The local edition does not collect or upload usage analytics."""
    return jsonify({"ok": True, "loggingEnabled": False}), 200


@app.route('/api/analysis_action/log', methods=['POST'])
def api_analysis_action_log():
    """The local edition does not collect or upload usage analytics."""
    return jsonify({"ok": True, "loggingEnabled": False}), 200


@app.route('/api/final_results/sync', methods=['POST'])
def api_final_results_sync():
    """The local edition does not collect or upload usage analytics."""
    return jsonify({"ok": True, "loggingEnabled": False}), 200


@app.route('/api/filemap/save', methods=['POST'])
def save_filemap():
    ensure_user_session_context()

    payload = request.get_json(silent=True) or {}
    project_id = _request_project_id(session.get("current_project_id"), payload)
    file_map = payload.get('fileMap') or payload.get('filemap') or payload.get('FileMap')
    if not isinstance(file_map, dict) or 'participants' not in file_map:
        return jsonify({"error": "Invalid file map payload"}), 400

    if session.get("mode") == "demo":
        filemap_path = get_filemap_path_for_project(_user_demo_project_id(project_id))
    else:
        filemap_path = get_filemap_path_for_project(project_id)
    if not filemap_path:
        return jsonify({"error": "Could not resolve session storage"}), 500

    try:
        with open(filemap_path, 'w', encoding='utf-8') as f:
            json.dump(file_map, f, indent=2)
        participants = file_map.get("participants") if isinstance(file_map, dict) else None
        participant_count = len(participants) if isinstance(participants, list) else 0
        _set_project_awaiting_first_upload(project_id, participant_count == 0)
        _mark_project_workflow_step(
            project_id,
            "files_mapped" if participant_count > 0 else "upload_files",
            {
                "participantCount": participant_count,
                "awaitingFirstUpload": participant_count == 0,
                "nextStep": "tagging" if participant_count > 0 else "upload_files",
            },
        )
        return jsonify({
            "message": "FileMap saved",
            "projectContext": {**get_project_context(), "currentProjectId": project_id}
        }), 200
    except Exception as e:
        print(f"Error saving FileMap: {e}")
        return jsonify({"error": "Server error while saving FileMap", "details": str(e)}), 500


@app.route('/api/filemap/load', methods=['GET'])
def load_filemap():
    ensure_user_session_context()

    project_id = _request_project_id(session.get("current_project_id"))
    project_context = {**get_project_context(), "currentProjectId": project_id}
    if session.get("mode") == "demo":
        ensure_demo_assets()
        filemap_path = get_filemap_path_for_project(_user_demo_project_id(project_id))
        if not filemap_path or not os.path.exists(filemap_path):
            return jsonify({"fileMap": None, "projectContext": project_context}), 200
        try:
            with open(filemap_path, 'r', encoding='utf-8') as f:
                file_map = json.load(f)
            return jsonify({"fileMap": file_map, "projectContext": project_context}), 200
        except Exception as e:
            print(f"Error loading demo FileMap: {e}")
            return jsonify({"error": "Server error while loading demo FileMap", "details": str(e)}), 500

    filemap_path = get_filemap_path_for_project(project_id)
    if not filemap_path or not os.path.exists(filemap_path):
        return jsonify({"fileMap": None, "projectContext": project_context}), 200

    try:
        with open(filemap_path, 'r', encoding='utf-8') as f:
            file_map = json.load(f)
        return jsonify({"fileMap": file_map, "projectContext": project_context}), 200
    except Exception as e:
        print(f"Error loading FileMap: {e}")
        return jsonify({"error": "Server error while loading FileMap", "details": str(e)}), 500


def _payload_bool(payload: dict, key: str, default: bool = False) -> bool:
    if not isinstance(payload, dict) or key not in payload:
        return default
    value = payload.get(key)
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes", "y", "on"}


def _remove_project_path(path: str | None, project_root: str | None, removed_paths: list[str]) -> bool:
    if not path or not os.path.exists(path):
        return False
    try:
        if os.path.isdir(path):
            shutil.rmtree(path)
        else:
            os.remove(path)
        removed_paths.append(_project_relative_storage_path(path, project_root) if project_root else path)
        return True
    except Exception as e:
        print(f"[WARN] Could not remove project runtime path {path}: {e}")
        return False


def _write_preserved_filemap(project_id: str, filemap_payload: dict | None) -> str | None:
    if not isinstance(filemap_payload, dict):
        return None
    participants = filemap_payload.get("participants")
    if not isinstance(participants, list) or not participants:
        return None

    session_id = session.get("session_id") if has_request_context() and "user_id" in session else f"maintenance_{int(time.time())}"
    session_dir = get_user_project_session_data_dir(project_id, session_id, create=True)
    filemap_path = os.path.join(session_dir, "filemap.json")
    try:
        with open(filemap_path, "w", encoding="utf-8") as f:
            json.dump(filemap_payload, f, indent=2, ensure_ascii=False)
        return filemap_path
    except Exception as e:
        print(f"[WARN] Could not restore preserved filemap for {project_id}: {e}")
        return None


def _clear_project_runtime_storage(project_id: str, payload: dict, mode: str = "user") -> dict:
    safe_project_id = _safe_project_id(project_id)
    project_root = get_user_project_base_dir(safe_project_id)
    removed_paths: list[str] = []
    preserved_paths: list[str] = []

    clear_all = _payload_bool(payload, "clearAll", False)
    clear_session_data = _payload_bool(payload, "clearSessionData", True) or clear_all
    reset_filemap = _payload_bool(payload, "resetFileMap", False) or clear_all
    clear_progress = _payload_bool(payload, "clearProgress", True) or clear_all
    clear_selection_state = _payload_bool(payload, "clearSelectionState", True) or clear_all
    clear_notes = _payload_bool(payload, "clearNotes", False) or clear_all
    clear_generated_outputs = _payload_bool(payload, "clearGeneratedOutputs", False) or clear_all
    clear_intermediate = _payload_bool(payload, "clearIntermediate", clear_generated_outputs) or clear_all
    clear_inputs = _payload_bool(payload, "clearInputs", False) or clear_all

    preserved_filemap = None
    if clear_session_data and not reset_filemap:
        preserved_filemap = _load_filemap_payload(_best_existing_filemap_path_for_project(safe_project_id))

    if clear_session_data:
        session_root = get_user_project_session_data_root(safe_project_id, create=False)
        _remove_project_path(session_root, project_root, removed_paths)
        restored_filemap_path = _write_preserved_filemap(safe_project_id, preserved_filemap)
        if restored_filemap_path:
            preserved_paths.append(_project_relative_storage_path(restored_filemap_path, project_root))

    if clear_progress:
        _remove_project_path(get_user_project_status_path(safe_project_id), project_root, removed_paths)
        with progress_lock:
            suffix = f"::{mode}::{safe_project_id}"
            for key in list(progress_store.keys()):
                if key.endswith(suffix):
                    progress_store.pop(key, None)

    outputs_dir = get_user_project_processed_dir(safe_project_id)
    if clear_generated_outputs:
        _remove_project_path(outputs_dir, project_root, removed_paths)
        os.makedirs(outputs_dir, exist_ok=True)
    elif clear_selection_state or clear_notes:
        cache_filenames = []
        if clear_selection_state:
            cache_filenames.extend([
                "SelectedThemes.json",
                "deletedQuotes.json",
                "non_verbal_audio_cues.json",
            ])
        if clear_notes:
            cache_filenames.append("notes.json")
        for filename in dict.fromkeys(cache_filenames):
            _remove_project_path(os.path.join(outputs_dir, filename), project_root, removed_paths)

    if clear_intermediate:
        _remove_project_path(get_user_project_intermediate_dir(safe_project_id), project_root, removed_paths)
        os.makedirs(get_user_project_intermediate_dir(safe_project_id), exist_ok=True)

    if clear_inputs:
        _remove_project_path(get_user_project_uploads_dir(safe_project_id), project_root, removed_paths)
        os.makedirs(get_user_project_uploads_dir(safe_project_id), exist_ok=True)
        _set_project_awaiting_first_upload(safe_project_id, True)
        if has_request_context() and _safe_project_id(session.get("current_project_id")) == safe_project_id:
            session["is_new_project"] = True

    if has_request_context() and _safe_project_id(session.get("current_project_id")) == safe_project_id:
        _clear_project_scoped_session_cache()
        session["themeObject"] = {}

    return {
        "projectId": safe_project_id,
        "removedPaths": removed_paths,
        "preservedPaths": preserved_paths,
        "options": {
            "clearSessionData": clear_session_data,
            "resetFileMap": reset_filemap,
            "clearProgress": clear_progress,
            "clearSelectionState": clear_selection_state,
            "clearNotes": clear_notes,
            "clearGeneratedOutputs": clear_generated_outputs,
            "clearIntermediate": clear_intermediate,
            "clearInputs": clear_inputs,
        },
    }


def _normalize_code_groups_storage_payload(payload):
    raw_groups = []
    raw_meta = {}
    if isinstance(payload, dict):
        raw_groups = payload.get("groups") if isinstance(payload.get("groups"), list) else []
        raw_meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
    elif isinstance(payload, list):
        raw_groups = payload

    cleaned_groups = []
    seen = set()
    for group in raw_groups:
        group_name = _normalize_group_path(group)
        if not group_name or group_name in seen:
            continue
        seen.add(group_name)
        cleaned_groups.append(group_name)

    normalized_meta = {}
    for group_name in cleaned_groups:
        meta_entry = raw_meta.get(group_name)
        if not isinstance(meta_entry, dict):
            meta_entry = {}
        normalized_meta[group_name] = {
            "comment": str(meta_entry.get("comment") or "")[:2000],
            "color": str(meta_entry.get("color") or "").strip()[:24],
        }

    return cleaned_groups, normalized_meta


def _normalize_group_list(raw_groups):
    if not isinstance(raw_groups, list):
        return []
    cleaned_groups = []
    seen = set()
    for group in raw_groups:
        group_name = _normalize_group_path(group)
        if not group_name or group_name in seen:
            continue
        seen.add(group_name)
        cleaned_groups.append(group_name)
    return cleaned_groups


def _update_groups_in_session_theme_object(theme_name: str, groups: list[str]) -> bool:
    theme_object = session.get('themeObject')
    if not isinstance(theme_object, dict):
        return False
    themes = theme_object.get('themes')
    if not isinstance(themes, list):
        return False

    target = _normalize_theme_lookup_name(theme_name)
    updated = False
    for theme in themes:
        if not isinstance(theme, dict):
            continue
        if _normalize_theme_lookup_name(theme.get('themeName')) != target:
            continue
        theme['groups'] = list(groups)
        updated = True
        break

    if updated:
        session['themeObject'] = theme_object
    return updated


@app.route('/process_all_transcripts', methods=['POST'])
def process_all_transcripts_route():
    ensure_user_session_context()

    request_payload = request.get_json(silent=True) or {}
    project_id = _request_project_id(session.get("current_project_id"), request_payload)
    file_map = request_payload.get("fileMap") if isinstance(request_payload.get("fileMap"), dict) else request_payload
    if not file_map or 'participants' not in file_map:
        return jsonify({"error": "Invalid or missing FileMap data."}), 400
    if isinstance(file_map, dict):
        file_map = {
            key: value
            for key, value in file_map.items()
            if key not in {"projectId", "project_id"}
        }

    try:
        if session.get("mode", "user") != "demo":
            filemap_path = get_filemap_path_for_project(project_id)
            if filemap_path:
                os.makedirs(os.path.dirname(filemap_path), exist_ok=True)
                with open(filemap_path, 'w', encoding='utf-8') as f:
                    json.dump(file_map, f, indent=2, ensure_ascii=False)
                participant_count = len(file_map.get("participants", [])) if isinstance(file_map.get("participants"), list) else 0
                _set_project_awaiting_first_upload(project_id, participant_count == 0)
                _mark_project_workflow_step(
                    project_id,
                    "transcripts_processing" if participant_count > 0 else "upload_files",
                    {
                        "participantCount": participant_count,
                        "awaitingFirstUpload": participant_count == 0,
                        "nextStep": "tagging" if participant_count > 0 else "upload_files",
                    },
                )

        # Pass the absolute paths to the processing function
        mode = session.get("mode", "user")
        demo_project_id = None
        if mode == "demo":
            ensure_demo_assets()
            demo_project_id = project_id or session.get("current_project_id") or DEFAULT_DEMO_PROJECT_ID
            input_directory = get_demo_project_uploads_dir(demo_project_id)
            output_directory = get_demo_project_outputs_dir(demo_project_id)
        else:
            input_directory = get_user_project_uploads_dir(project_id)
            output_directory = get_user_project_processed_dir(project_id)
        if mode != "demo":
            status_path = _resolve_status_path_for_mode(mode, project_id)
            job_key = _generation_job_key(session["user_id"], project_id=project_id, mode=mode)
            input_signature = _tagging_input_signature(
                mode=mode,
                project_id=project_id,
                uploads_dir=input_directory,
                file_map=file_map,
            )
            start_state = _tagging_start_state(
                session["user_id"],
                mode,
                project_id,
                status_path,
                input_signature,
                job_key,
            )
            if start_state.get("status") == "already_running":
                return jsonify({
                    "message": "Tagging is already running. Transcript processing was not restarted.",
                    "projectId": project_id,
                    "skipped": True,
                    "taggingStatus": "already_running",
                    "inputChanged": start_state.get("inputChanged", False),
                }), 200
            if start_state.get("status") == "up_to_date":
                return jsonify({
                    "message": "No file changes detected. Transcript processing and tagging are already up to date.",
                    "projectId": project_id,
                    "skipped": True,
                    "taggingStatus": "up_to_date",
                }), 200
        processed_data, preservation_stats = _process_transcripts_preserving_manual_state(
            input_directory=input_directory,
            output_directory=output_directory,
            file_map=file_map # Pass the manifest
        )

        if not processed_data:
            return jsonify({"error": "No valid transcripts were found. Review the uploaded files before continuing."}), 422

        if mode == "demo":
            output_filename = _processed_transcripts_url_for_mode("demo", demo_project_id)
        else:
            output_filename = _processed_transcripts_url_for_mode("user", project_id)
        if mode != "demo":
            _mark_project_workflow_step(
                project_id,
                "transcripts_processed",
                {
                    "processedEntryCount": len(processed_data),
                    "nextStep": "tagging",
                },
            )
        return jsonify({
            "message": f"All transcripts processed. {len(processed_data)} entries created in JSON.",
            "outputPath": url_for('static', filename=output_filename),
            "projectId": project_id,
        }), 200
    except ValueError as error:
        return jsonify({"error": str(error)}), 422
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": "A server error occurred while processing all transcripts.", "details": str(e)}), 500


@app.route('/visualization', methods=['GET', 'POST'])
def visualization():
    ensure_user_session_context()
    mode = session.get('mode', 'user') # Default to 'user' if not set
    if request.method == 'POST':
        request_payload = request.json or {}
        project_id = _request_project_id(session.get("current_project_id"), request_payload)
        if _current_user_project_requires_upload_notice(project_id):
            return jsonify({"error": "Upload file in File Manager first to continue."}), 400
        themeObject2 = {
            key: value
            for key, value in request_payload.items()
            if key not in {"projectId", "project_id"}
        }
        themeObject2["appliedToVisualization"] = True
        themeObject2["selectionStage"] = "applied_codes"
        themeObject2.setdefault("selectionSource", "apply_codes")
        if _has_theme_payload(themeObject2):
            try:
                output_dir = _selected_themes_output_dir(mode=mode, project_id=project_id)
                previous_payload = _load_json_payload_if_exists(
                    os.path.join(output_dir, 'SelectedThemes.json'),
                    {"themes": []},
                )
                _persist_selected_theme_payload(
                    themeObject2,
                    mode=mode,
                    project_id=project_id,
                )
            except Exception as e:
                print(f"[WARN] Failed to persist selected themes during visualization handoff: {e}")
                return jsonify({"error": "Could not prepare Visualization. Please try again."}), 500
        print(themeObject2)
        if _safe_project_id(project_id) == _safe_project_id(session.get("current_project_id")):
            _store_theme_object_in_session(themeObject2, project_id)
        return '', 204  # No Content response, as this is an AJAX call

    # tag_questions_answers() can be used to force Qwen Q&A retagging.
    print(f"Rendering visualization page in '{mode}' mode.")
    if _current_user_project_requires_upload_notice():
        return _render_upload_required_page(
            active_tab="visualization-tab",
            active_icon="/static/images/Enable_Visualization.png",
        )
    if mode == 'demo':
        ensure_demo_assets()
        _ensure_demo_visualization_seed(session.get("current_project_id"))
        demo_output_dir = get_demo_project_outputs_dir(session.get("current_project_id"))
        selected_theme_payload = _load_selected_theme_payload(demo_output_dir)
        if _has_selected_theme_state(selected_theme_payload):
            themeObject2 = _merge_generated_quotes_into_theme_payload(selected_theme_payload, demo_output_dir)
        else:
            session_theme_object = session.get('themeObject', {}) or {}
            if not _has_selected_theme_state(session_theme_object) or _session_theme_object_is_summary(session_theme_object):
                session_theme_object = build_theme_object_from_output(get_demo_output_json_path(session.get("current_project_id")))
            themeObject2 = _strip_theme_payload_words(session_theme_object)
        _store_theme_object_in_session(themeObject2, session.get("current_project_id"))
    else:
        project_id = _request_project_id(session.get("current_project_id"))
        themeObject2 = _visualization_theme_payload(
            mode=mode,
            project_id=project_id,
            require_applied_selection=True,
        )
        if not _has_theme_payload(themeObject2) and _project_theme_generation_running("user", project_id):
            themeObject2 = {"themes": []}
        _store_theme_object_in_session(themeObject2, project_id)
    processed_transcripts_url = None
    if mode == 'demo':
        processed_path = get_demo_processed_transcripts_path(session.get("current_project_id"))
        if _json_file_has_content(processed_path):
            processed_transcripts_url = _processed_transcripts_url_for_mode(mode, session.get("current_project_id"))
    else:
        project_id = _request_project_id(session.get("current_project_id"))
        processed_path = get_user_processed_transcripts_path(project_id)
        if _json_file_has_content(processed_path):
            processed_transcripts_url = _processed_transcripts_url_for_mode(mode, project_id)
    response = make_response(render_template(
        'visualization.html',
        themeObject2=themeObject2,
        mode=mode,
        processed_transcripts_url=processed_transcripts_url
    ))
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

@app.route('/transcriptmode', methods=['GET', 'POST'])
def transcriptmode():
    ensure_user_session_context()
    if request.method == 'POST':
        if _current_user_project_requires_upload_notice():
            return jsonify({"error": "Upload file in File Manager first to continue."}), 400
        themeObject2 = request.json
        _store_theme_object_in_session(themeObject2, session.get("current_project_id"))
        return '', 204  # No Content response, as this is an AJAX call

    mode = session.get('mode', 'user')
    if _current_user_project_requires_upload_notice():
        return _render_upload_required_page(
            active_tab="transcript-tab",
            active_icon="/static/images/Enable_editor.png",
        )
    themeObject2 = _theme_object_for_transcript_mode(
        mode,
        session.get("current_project_id"),
    )
    _store_theme_object_in_session(themeObject2, session.get("current_project_id"))
    # tag_questions_answers() can be used to force Qwen Q&A retagging.
    processed_transcripts_url = _processed_transcripts_url_for_mode(
        mode,
        session.get("current_project_id"),
    )
    return render_template('transcriptModeStart.html', themeObject2=themeObject2,mode=mode, processed_transcripts_url=processed_transcripts_url)

@app.route('/transcriptmodedetail', methods=['GET', 'POST'])
def transcriptmodedetail():
    participant = request.args.get('participant')
    if 'user' in session:
        ensure_user_session_context()
        mode = session.get('mode', 'user')
        if _current_user_project_requires_upload_notice():
            return _render_upload_required_page(
                active_tab="transcript-tab",
                active_icon="/static/images/Enable_editor.png",
            )
        themeObject2 = _theme_object_for_transcript_mode(
            mode,
            session.get("current_project_id"),
        )
        _store_theme_object_in_session(themeObject2, session.get("current_project_id"))
        processed_transcripts_url = _processed_transcripts_url_for_mode(
            mode,
            session.get("current_project_id"),
        )
        return render_template('transcriptMode.html', themeObject2=themeObject2, participant=participant,mode=mode, processed_transcripts_url=processed_transcripts_url)
    else:
        return redirect(url_for('home'))

# --- ROUTE TO SAVE NOTES ---
@app.route('/api/save_notes', methods=['POST'])
def save_notes():
    ensure_user_session_context()

    notes_data = request.get_json()
    if notes_data is None:
        return jsonify({"error": "No data received"}), 400

    mode = session.get('mode', 'user')
    project_id = _request_project_id(session.get("current_project_id"), notes_data if isinstance(notes_data, dict) else None)
    if isinstance(notes_data, dict) and ("projectId" in notes_data or "project_id" in notes_data):
        if "notes" in notes_data:
            notes_data = notes_data.get("notes") or {}
        else:
            notes_data = {
                key: value
                for key, value in notes_data.items()
                if key not in {"projectId", "project_id"}
            }

    # Determine the correct file path based on the mode
    if mode == 'demo':
        notes_filepath = get_demo_notes_path(project_id)
    else:
        # User mode saves per project so notes don't bleed across Project 1/2/3
        notes_filepath = os.path.join(get_user_project_processed_dir(project_id), 'notes.json')

    try:
        os.makedirs(os.path.dirname(notes_filepath), exist_ok=True)
        with open(notes_filepath, 'w', encoding='utf-8') as f:
            json.dump(notes_data, f, indent=4)
        print(f"Notes saved successfully to: {notes_filepath}")
        return jsonify({"message": "Notes saved successfully."}), 200
    except Exception as e:
        print(f"Error saving notes: {e}")
        return jsonify({"error": "Server error while saving notes"}), 500


# --- ROUTE TO LOAD NOTES ---
@app.route('/api/load_notes', methods=['GET'])
def load_notes():
    ensure_user_session_context()

    mode = session.get('mode', 'user')
    project_id = _request_project_id(session.get("current_project_id"))

    if mode == 'demo':
        notes_filepath = get_demo_notes_path(project_id)
    else:
        notes_filepath = os.path.join(get_user_project_processed_dir(project_id), 'notes.json')

    try:
        if os.path.exists(notes_filepath):
            with open(notes_filepath, 'r', encoding='utf-8') as f:
                notes_data = json.load(f)
            return jsonify(notes_data), 200
        else:
            # If the file doesn't exist, it's not an error, just return an empty object
            return jsonify({}), 200
    except Exception as e:
        print(f"Error loading notes: {e}")
        return jsonify({"error": "Server error while loading notes"}), 500


@app.route('/default')
def default_fragment():
    return render_template('transcriptModeDefault.html')


@app.route('/fileManager', methods=['POST', 'GET'])
def fileManager():
    ensure_user_session_context()
    mode = session.get('mode', 'user')
    if mode == 'demo':
        ensure_demo_assets()
        _store_theme_object_in_session(
            _ensure_demo_visualization_seed(session.get("current_project_id")),
            session.get("current_project_id"),
        )
    return render_template('chromascribe-index.html', mode=mode)

@app.route('/', methods=['POST', 'GET'])
def home():
    ensure_user_session_context()
    return render_template('home.html')


@app.route('/progress')
def get_progress():

    user_id = session['user_id']
    mode = session.get("mode", "user")
    project_id = _request_project_id(session.get("current_project_id"))
    status_path = _resolve_status_path_for_mode(mode, project_id)
    return jsonify(get_progress_for_user(user_id, project_id=project_id, mode=mode, status_path=status_path))


# API CALL- Sending Topics to Front-End
@app.route('/get_chosen_themes', methods=['POST', 'GET'])
def get_chosen_themes():
  try:
    request_payload = request.get_json(silent=True)
    project_id = _request_project_id(
      session.get("current_project_id"),
      request_payload if isinstance(request_payload, dict) else None,
    )
    themes = request_payload.get("themes") if isinstance(request_payload, dict) else request_payload
    if not isinstance(themes, list):
      themes = []
    mode = session.get('mode', 'user')
    runtime_dirs = _resolve_project_runtime_dirs(mode, project_id)
    processed_dir = runtime_dirs.get("processed_dir")

    output_json_path = os.path.join(processed_dir, "ai_generated.json") if processed_dir else ""
    print(
      f"[DEBUG][/get_chosen_themes] mode={mode} "
      f"project_id={project_id} processed_dir={processed_dir} "
      f"output_json={output_json_path} output_exists={os.path.exists(output_json_path) if output_json_path else False}"
    )
    print(f"[DEBUG][/get_chosen_themes] requested_theme_count={len(themes)} sample={themes[:5]}")

    qwen = _build_qwen_runtime(
      mode,
      project_id,
      processed_dir=processed_dir,
      intermediate_dir=runtime_dirs.get("intermediate_dir"),
    )
    topics = qwen.get_topic_for_themes_qwen(themes, processed_dir=processed_dir)
    print(f"Topics: {topics}")
    return jsonify(topics)
  except Exception as e:
    print(e)
    return jsonify({"error": str(e)}), 500


@app.route("/get_similar_sentences", methods=["POST"])
def get_similar_sentences():
    ensure_user_session_context()

    data = request.get_json(silent=True) or {}
    theme = str(data.get("theme") or "").strip()
    chosen_themes = data.get("chosen_themes")
    if not isinstance(chosen_themes, list):
        chosen_themes = []
    chosen_themes = [str(theme_name).strip() for theme_name in chosen_themes if str(theme_name or "").strip()]

    if not theme:
        return jsonify({"error": "Missing selected code."}), 400
    if not chosen_themes:
        return jsonify({"error": "No codes are available to search."}), 400

    user_id = session.get("user_id")
    mode = session.get("mode", "user")
    project_id = _request_project_id(session.get("current_project_id"), data)
    runtime_dirs = _resolve_project_runtime_dirs(mode, project_id)
    processed_dir = runtime_dirs.get("processed_dir")
    uploads_dir = runtime_dirs.get("uploads_dir")
    if not processed_dir:
        return jsonify({"error": "Could not resolve project transcript data."}), 500
    file_map_for_scope = None
    if mode != "demo":
        file_map_for_scope = _load_filemap_payload(get_filemap_path_for_project(project_id)) or {"participants": []}
    source_files = sorted(
        _current_uploaded_transcript_output_keys(
            mode=mode,
            project_id=project_id,
            uploads_dir=uploads_dir,
            file_map=file_map_for_scope,
        ),
        key=lambda value: value.lower(),
    )
    if mode != "demo" and not source_files:
        return jsonify({
            "error": "No currently uploaded transcript files are available for similar-excerpt search.",
            "code": "no_current_uploaded_transcripts",
        }), 400

    job_key = _theme_job_key(user_id, theme, project_id=project_id, mode=mode)
    task_id = str(uuid.uuid4())
    cancel_event = Event()
    with similar_excerpt_jobs_lock:
        if job_key in similar_excerpt_jobs:
            existing_task_id = similar_excerpt_job_tasks.get(job_key)
            existing_task = similar_excerpt_tasks.get(existing_task_id or "", {})
            return jsonify({
                "status": "already_running_for_theme",
                "theme": theme,
                "task_id": existing_task_id,
                "message": "A similar-excerpt search is already running for this code.",
                "sourceFiles": existing_task.get("sourceFiles") if isinstance(existing_task.get("sourceFiles"), list) else source_files,
            }), 202
        similar_excerpt_jobs.add(job_key)
        similar_excerpt_job_tasks[job_key] = task_id
        similar_excerpt_cancel_events[task_id] = cancel_event

    _update_similar_excerpt_task(
        task_id,
        status="processing",
        phase="start",
        message="Starting similar excerpt search.",
        theme=theme,
        projectId=project_id,
        mode=mode,
        startedAt=datetime.now(timezone.utc).isoformat(),
        jobKey=job_key,
        ownerUid=session["user_id"],
        progressPercent=0,
        processedChunks=0,
        totalChunks=0,
        sourceFiles=source_files,
    )

    thread = Thread(
        target=generate_similar_sentences_background,
        args=(task_id, theme, chosen_themes, mode, project_id, processed_dir, job_key, cancel_event, session.get("user_workspace_key"), source_files),
        daemon=True,
    )
    thread.start()

    return jsonify({
        "status": "started",
        "task_id": task_id,
        "theme": theme,
        "message": "Similar excerpt search started.",
        "sourceFiles": source_files,
    }), 202


@app.route("/task_status/<task_id>", methods=["GET"])
def task_status(task_id):
    task = similar_excerpt_tasks.get(task_id)
    if not task or task.get("ownerUid") != session.get("user_id"):
        return jsonify({
            "status": "not_found",
            "message": "Could not find this similar-excerpt search. It may have expired.",
        }), 404
    return jsonify(task)


@app.route("/task_status/<task_id>/cancel", methods=["POST"])
def cancel_similar_excerpt_task(task_id):
    task = similar_excerpt_tasks.get(task_id)
    if not task or task.get("ownerUid") != session.get("user_id"):
        return jsonify({
            "status": "not_found",
            "message": "Could not find this similar-excerpt search. It may have expired.",
        }), 404

    if task.get("status") in {"done", "error", "cancelled"}:
        return jsonify(task), 200

    cancel_event = similar_excerpt_cancel_events.get(task_id)
    if cancel_event:
        cancel_event.set()

    updated = _update_similar_excerpt_task(
        task_id,
        status="cancelling",
        phase="cancelling",
        message="Stopping similar excerpt search.",
        theme=task.get("theme", ""),
        cancelRequested=True,
        progressPercent=max(0, min(99, int(task.get("progressPercent") or 0))),
    )
    return jsonify(updated), 202


@app.route('/api/save_theme_tag', methods=['POST'])
def save_theme_tag():
    ensure_user_session_context()

    data_for_tag = request.get_json(silent=True) or {}
    project_id = _request_project_id(session.get("current_project_id"), data_for_tag)
    theme_name = data_for_tag.get('themeName')
    speaker = str(data_for_tag.get('speaker') or "").strip()
    quote_text = data_for_tag.get('text')
    participant = normalize_participant_id(data_for_tag.get('participantId') or data_for_tag.get('participant')) or _normalize_theme_participant_code(speaker)
    tag = _normalize_theme_qa_tag(data_for_tag.get('tag') or speaker)
    timestamp = _normalize_theme_timestamp(data_for_tag.get('timestamp'))
    cue_text = str(data_for_tag.get('cueText') or "").strip().strip('"').strip("'")

    if not all([theme_name, speaker, quote_text]):
        return jsonify({"error": "Missing required data from frontend"}), 400

    mode = session.get('mode', 'user')
    output_filepath = _output_json_path_for_mode_project(mode=mode, project_id=project_id)

    try:
        # Read the existing ai_generated.json file
        if os.path.exists(output_filepath):
            with open(output_filepath, 'r', encoding='utf-8') as f:
                output_data = json.load(f)
        else:
            # If the file doesn't exist, create a default structure
            output_data = {}
        if not isinstance(output_data, dict):
            output_data = {}

        target_key = _find_theme_key_in_output(output_data, theme_name)

        selected_theme = None
        selected_payload = _load_selected_theme_payload(os.path.dirname(output_filepath))
        if isinstance(selected_payload, dict):
            for candidate_theme in selected_payload.get("themes", []) or []:
                if not isinstance(candidate_theme, dict):
                    continue
                candidate_name = candidate_theme.get("themeName") or candidate_theme.get("theme") or candidate_theme.get("name")
                if _normalize_theme_lookup_name(candidate_name) == _normalize_theme_lookup_name(theme_name):
                    selected_theme = candidate_theme
                    break

        created_theme = False
        if not target_key:
            target_key = str((selected_theme or {}).get("themeName") or theme_name).strip()
            output_data[target_key] = {}
            created_theme = True

        theme_payload = output_data.get(target_key)
        if not isinstance(theme_payload, dict):
            theme_payload = {}
            output_data[target_key] = theme_payload

        if selected_theme:
            for metadata_key in ("summary", "color", "comment"):
                metadata_value = str(selected_theme.get(metadata_key) or "").strip()
                if metadata_value and not str(theme_payload.get(metadata_key) or "").strip():
                    theme_payload[metadata_key] = metadata_value
            if isinstance(selected_theme.get("groups"), list) and not isinstance(theme_payload.get("groups"), list):
                theme_payload["groups"] = list(selected_theme.get("groups") or [])

        new_quote = {
            "speaker": speaker,
            "text": str(quote_text).strip().strip('"').strip("'"),
            "ai_generated": False,
            "codeSource": "manual",
        }
        for metadata_key in ("segmentId", "sourceFile", "participantId", "startSeconds", "endSeconds"):
            if metadata_key in data_for_tag:
                new_quote[metadata_key] = data_for_tag[metadata_key]
        if participant:
            new_quote["participant"] = participant
        if tag:
            new_quote["tag"] = tag
        if timestamp:
            new_quote["timestamp"] = timestamp
        if cue_text:
            new_quote["cueText"] = cue_text

        if not isinstance(theme_payload.get('quotes'), list):
            theme_payload['quotes'] = []
        new_quote_identity = _build_theme_word_identity_key(new_quote)
        already_exists = any(
            _build_theme_word_identity_key(existing_quote) == new_quote_identity
            for existing_quote in theme_payload['quotes']
        )
        if not already_exists:
            theme_payload['quotes'].append(new_quote)
        output_data[target_key] = theme_payload
        # print("OUTPUT DATA",output_data)

        os.makedirs(os.path.dirname(output_filepath), exist_ok=True)
        with open(output_filepath, 'w', encoding='utf-8') as f:
            json.dump(output_data, f, indent=2, ensure_ascii=False)

        print(f"Appended quote to theme '{target_key}' in '{output_filepath}'")
        return jsonify({"message": "Theme tag saved successfully.", "createdTheme": created_theme}), 200

    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"Error saving theme tag: {e}")
        return jsonify({"error": "Server error while saving theme tag"}), 500


@app.route('/api/delete_theme_tag', methods=['POST'])
def delete_theme_tag():
    ensure_user_session_context()

    data_for_tag = request.get_json(silent=True) or {}
    project_id = _request_project_id(session.get("current_project_id"), data_for_tag)
    theme_name = data_for_tag.get('themeName')
    speaker = str(data_for_tag.get('speaker') or "").strip()
    quote_text = data_for_tag.get('text') or data_for_tag.get('word')
    participant = normalize_participant_id(data_for_tag.get('participantId') or data_for_tag.get('participant')) or _normalize_theme_participant_code(speaker)
    tag = _normalize_theme_qa_tag(data_for_tag.get('tag') or speaker)
    timestamp = _normalize_theme_timestamp(data_for_tag.get('timestamp'))
    cue_text = str(data_for_tag.get('cueText') or "").strip().strip('"').strip("'")

    if not all([theme_name, quote_text]):
        return jsonify({"error": "Missing required data from frontend"}), 400

    mode = session.get('mode', 'user')
    output_filepath = _output_json_path_for_mode_project(mode=mode, project_id=project_id)

    try:
        if not os.path.exists(output_filepath):
            return jsonify({"message": "Theme tag not found.", "removedCount": 0}), 200

        with open(output_filepath, 'r', encoding='utf-8') as f:
            output_data = json.load(f)

        target_key = _find_theme_key_in_output(output_data, theme_name)
        if not target_key:
            return jsonify({"message": "Theme tag not found.", "removedCount": 0}), 200

        theme_payload = output_data.get(target_key)
        if not isinstance(theme_payload, dict):
            return jsonify({"message": "Theme tag not found.", "removedCount": 0}), 200

        quotes = theme_payload.get('quotes', [])
        if not isinstance(quotes, list):
            return jsonify({"message": "Theme tag not found.", "removedCount": 0}), 200

        target_entry = _build_theme_word_entry({
            "text": quote_text,
            "speaker": speaker,
            "participant": participant,
            "tag": tag,
            "timestamp": timestamp,
            "cueText": cue_text,
            "segmentId": data_for_tag.get("segmentId"),
            "sourceFile": data_for_tag.get("sourceFile"),
            "participantId": data_for_tag.get("participantId") or participant,
        })
        target_identity = _build_theme_word_identity_key(target_entry)

        kept_quotes = []
        removed_count = 0
        for quote in quotes:
            quote_entry = _build_theme_word_entry(quote)
            quote_identity = _build_theme_word_identity_key(quote_entry)
            if target_identity and quote_identity == target_identity:
                removed_count += 1
            else:
                kept_quotes.append(quote)

        if removed_count > 0:
            theme_payload['quotes'] = kept_quotes
            with open(output_filepath, 'w', encoding='utf-8') as f:
                json.dump(output_data, f, indent=2)


        return jsonify({"message": "Theme tag removed.", "removedCount": removed_count}), 200
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"Error deleting theme tag: {e}")
        return jsonify({"error": "Server error while deleting theme tag"}), 500


# --- ROUTE TO ADD A NEW THEME/CODE TO THE LIST FROM TRANSCRIPT MODE---
@app.route('/api/add_new_theme', methods=['POST'])
def add_new_theme():
    ensure_user_session_context()

    data = request.get_json() or {}
    project_id = _request_project_id(session.get("current_project_id"), data)
    new_theme_name = data.get('themeName')

    if not new_theme_name:
        return jsonify({"error": "Missing themeName."}), 400

    mode = session.get('mode', 'user')
    output_filepath = _output_json_path_for_mode_project(mode=mode, project_id=project_id)

    try:
        if os.path.exists(output_filepath):
            with open(output_filepath, 'r', encoding='utf-8') as f:
                output_data = json.load(f)
        else:
            output_data = {}

        # Create a display-friendly key for the JSON file without changing user-entered casing.
        display_key = str(new_theme_name).replace('_', ' ').strip()
        existing_key = _find_theme_key_in_output(output_data, new_theme_name) or _find_theme_key_in_output(output_data, display_key)
        target_key = existing_key or display_key
        color = _normalize_hex_theme_color(data.get("color"))

        # Add the new theme with an empty quotes array if it doesn't exist
        already_exists = existing_key is not None
        if not already_exists:
            output_data[target_key] = {
                "summary": "",
                "quotes": [],
                "ai_generated": False,
                "codeSource": "manual",
                "color": color,
                "groups": data.get("groups") if isinstance(data.get("groups"), list) else [],
                "comment": str(data.get("comment") or ""),
            }
            print(f"Theme '{target_key}' not found in ai_generated.json. CREATING NEW ENTRY.")
        elif isinstance(output_data.get(target_key), dict):
            if color:
                output_data[target_key]["color"] = color
            if isinstance(data.get("groups"), list) and not isinstance(output_data[target_key].get("groups"), list):
                output_data[target_key]["groups"] = data.get("groups")
            if str(data.get("comment") or "").strip() and not str(output_data[target_key].get("comment") or "").strip():
                output_data[target_key]["comment"] = str(data.get("comment") or "")

        os.makedirs(os.path.dirname(output_filepath), exist_ok=True)
        with open(output_filepath, 'w', encoding='utf-8') as f:
            json.dump(output_data, f, indent=2)

        print(f"Added/updated theme '{target_key}' in '{output_filepath}'")
        return jsonify({"message": "Theme added successfully."}), 200

    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"Error adding new theme: {e}")
        return jsonify({"error": "Server error while adding theme"}), 500
# --- END OF NEW ROUTE ---


# API for uploaded files to run model on it
@app.route('/run_model_on_uploaded_files', methods =['POST', 'GET'])
def get_uploaded_files_themes():

  try:
    mode = session.get('mode', 'user')
    project_id = _request_project_id(session.get("current_project_id"))
    remove_existing_themes_file(project_id=project_id, mode=mode)
    runtime_dirs = _resolve_project_runtime_dirs(mode, project_id)
    qwen_qna = _build_qna_runtime(
        mode,
        project_id,
        processed_dir=runtime_dirs.get("processed_dir"),
        uploads_dir=runtime_dirs.get("uploads_dir"),
        intermediate_dir=runtime_dirs.get("intermediate_dir"),
    )
    qwen = _build_qwen_runtime(
        mode,
        project_id,
        processed_dir=runtime_dirs.get("processed_dir"),
        intermediate_dir=runtime_dirs.get("intermediate_dir"),
    )

    # Qwen3 pipeline (Ollama/OpenAI-compatible backend configured in processing scripts)
    qwen_qna.extract_interviewer_script()
    qwen_qna.tag_questions_batch(batch_size=14)
    qwen_qna.add_tagged_questions()
    _refresh_qna_tag_conflicts_for_path(qwen_qna.TRANSCRIPTS_JSON_PATH)
    qwen_qna.extract_questions_possible_answers()
    qwen_qna.tag_answer_batch(batch_size=14)
    qwen_qna.add_tagged_answers()
    _refresh_qna_tag_conflicts_for_path(qwen_qna.TRANSCRIPTS_JSON_PATH)
    qwen.extract_answers_by_tag()
    topics = qwen.qwenModel()
    words = write_topics_qwen(topics, project_id=project_id, mode=mode)
    return jsonify(words)
  except OSError as e:
        print(f"Error: {e.strerror}")
  except Exception as e:
    print(e)
    return render_template("basic.html")

# Directory where uploaded files will be stored
UPLOAD_FOLDER = TRANSCRIPTS_STORAGE_DIR
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER

def remove_existing_themes_file(project_id: str | None = None, mode: str | None = None, processed_dir: str | None = None):
  file_path = _themes_txt_path(project_id=project_id, mode=mode, processed_dir=processed_dir)
  # Attempt to remove the file
  if os.path.isfile(file_path):
    os.remove(file_path)
  print(f"File '{file_path}' removed successfully.")


# Validate and store the original transcript before offering it for analysis.
@app.route('/upload_transcript_file', methods=['POST'])
def upload_and_process_transcript_route():

    ensure_user_session_context()

    print(f"Received request for /upload_transcript_file from user {session['user_id']}")

    if 'transcript_file' not in request.files:
        print("No transcript_file part in request.files")
        return jsonify({"error": "No transcript_file part"}), 400

    file = request.files['transcript_file']
    client_relative_path = request.form.get('relativePath', file.filename)

    print(f"Processing file: {file.filename}, relativePath: {client_relative_path}")

    if file.filename == '':
        print("No file selected (empty filename)")
        return jsonify({"error": "No file selected"}), 400

    # Sanitize client_relative_path
    if ".." in client_relative_path or client_relative_path.startswith(("/", "\\")):
        print(f"Invalid relative path attempt: {client_relative_path}")
        return jsonify({"error": "Invalid relative path"}), 400

    mode = session.get("mode", "user")
    storage_base_dir = get_transcript_storage_dir_for_mode(mode=mode)
    target_save_dir = os.path.join(storage_base_dir, os.path.dirname(client_relative_path))
    try:
        os.makedirs(target_save_dir, exist_ok=True)
    except OSError as e:
        print(f"Error creating directory {target_save_dir}: {e}")
        return jsonify({"error": "Server error creating storage directory", "details": str(e)}), 500

    server_final_filename = ""
    server_final_filepath = ""

    try:
        server_final_filename = os.path.basename(client_relative_path)
        server_final_filepath = os.path.join(target_save_dir, server_final_filename)
        import_result = save_transcript_upload(file, server_final_filepath, client_relative_path)

        path_for_url = os.path.join(os.path.dirname(client_relative_path), server_final_filename).replace("\\","/")

        server_transcript_url = url_for('serve_transcript_file', filepath=path_for_url)
        print(f"Generated transcript URL: {server_transcript_url} for file {server_final_filename}")

        return jsonify({
            "message": "Transcript processed and stored successfully.",
            "originalFilename": file.filename,
            "clientRelativePath": client_relative_path,
            "processedFilenameOnServer": server_final_filename,
            "serverTranscriptUrl": server_transcript_url,
            **import_result,
        }), 200

    except ValueError as error:
        return jsonify({"error": str(error)}), 422
    except Exception as error:
        app.logger.exception("Could not import transcript %s", file.filename)
        return jsonify({"error": "The transcript could not be read. Check the file and try again."}), 500


# Route to serve transcript files from mode-scoped storage
@app.route('/serve_transcript/<path:filepath>')
def serve_transcript_file(filepath):
    mode = session.get("mode", "user")
    relative_path = _sanitize_relative_path(filepath)
    if not relative_path:
        print(f"Forbidden access attempt for transcript: {filepath}")
        return "Forbidden: Invalid path", 403

    demo_project_dir = None
    if mode == "demo":
        ensure_demo_assets()
        demo_project_id = session.get("current_project_id") or DEFAULT_DEMO_PROJECT_ID
        demo_project_dir = get_demo_project_dir(demo_project_id) or get_demo_project_dir(DEFAULT_DEMO_PROJECT_ID)

    resolved_transcript_path = _resolve_transcript_path_for_mode(
        relative_path,
        mode,
        demo_project_dir=demo_project_dir
    )
    if not resolved_transcript_path:
        print(f"Transcript file not found for serving: {relative_path} (mode={mode})")
        return "Transcript file not found on server.", 404

    print(f"Serving transcript: {relative_path} from file: {resolved_transcript_path}")
    return send_from_directory(
        os.path.dirname(resolved_transcript_path),
        os.path.basename(resolved_transcript_path),
        as_attachment=False
    )


def _normalize_speaker_role_name(value) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip()).casefold()


def _canonical_speaker_role_label(value) -> str | None:
    normalized = _normalize_speaker_role_name(value)
    if normalized == "interviewer":
        return "Interviewer"
    if normalized in {"participant", "interviewee"}:
        return "Participant"
    return None


def _processed_transcript_participant_id(file_key, entry) -> str:
    if not isinstance(entry, dict):
        return ""
    explicit_participant = normalize_participant_id(entry.get("participantId") or entry.get("participant"))
    if explicit_participant:
        return explicit_participant
    for candidate in (entry.get("audiofile"), file_key):
        participant = _normalize_theme_participant_code(candidate)
        if participant:
            return participant
    return ""


def _normalize_qna_tag_value(raw_tag) -> str:
    value = str(raw_tag or "").strip()
    if not value or value.lower() in {"none", "null", "undefined"}:
        return ""
    match = re.match(r"^([QA])\s*0*(\d+)([A-Za-z]?)$", value, flags=re.IGNORECASE)
    if not match:
        return ""
    return f"{match.group(1).upper()}{int(match.group(2))}{match.group(3).lower()}"


def _qna_manual_tag_state(cue: dict | None) -> tuple[bool, str]:
    if not isinstance(cue, dict):
        return False, ""
    source = str(cue.get("tagSource") or "").strip().lower()
    has_manual = source in {"manual", "human"} or "manualTag" in cue
    manual_raw = cue.get("manualTag") if "manualTag" in cue else cue.get("tag")
    return has_manual, _normalize_qna_tag_value(manual_raw)


def _qna_resolution_matches(cue: dict | None, manual_tag: str, ai_tag: str) -> bool:
    if not isinstance(cue, dict):
        return False
    resolution = str(cue.get("tagConflictResolution") or "").strip().lower()
    if resolution not in {"keep_manual", "keep_both", "dismiss"}:
        return False
    resolved_manual = _normalize_qna_tag_value(cue.get("tagConflictResolvedManualTag"))
    resolved_ai = _normalize_qna_tag_value(cue.get("tagConflictResolvedAiTag"))
    explicit_empty_choice = cue.get("tagConflictResolvedManualTag") == "None"
    if not resolved_ai or (not resolved_manual and not explicit_empty_choice):
        return False
    return resolved_manual == manual_tag and resolved_ai == ai_tag


def _clear_qna_conflict_fields(cue: dict):
    cue.pop("tagConflict", None)
    cue.pop("tagConflictType", None)


def _clear_qna_resolution_fields(cue: dict):
    cue.pop("tagConflictResolution", None)
    cue.pop("tagConflictResolvedAt", None)
    cue.pop("tagConflictResolvedManualTag", None)
    cue.pop("tagConflictResolvedAiTag", None)


def _mark_qna_conflict_resolved(cue: dict, action: str, manual_tag: str, ai_tag: str):
    cue["tagConflictResolution"] = action
    cue["tagConflictResolvedAt"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    cue["tagConflictResolvedManualTag"] = manual_tag or "None"
    cue["tagConflictResolvedAiTag"] = ai_tag or "None"
    _clear_qna_conflict_fields(cue)


def _tag_conflicts_path_for_mode(mode: str | None = None, project_id: str | None = None) -> str:
    resolved_mode = mode if mode is not None else session.get("mode", "user")
    resolved_project_id = project_id if project_id is not None else session.get("current_project_id")
    if resolved_mode == "demo":
        return get_demo_tag_conflicts_path(resolved_project_id)
    return get_user_tag_conflicts_path(resolved_project_id)


def _empty_qna_tag_conflicts_payload() -> dict:
    return {
        "conflicts": [],
        "summary": {"openCount": 0, "questionCount": 0, "answerCount": 0},
        "updatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    }


def _build_qna_tag_conflict_record(file_key: str, content: dict, cue: dict, transcript_index: int, manual_tag: str, ai_tag: str) -> dict:
    participant = _processed_transcript_participant_id(file_key, content)
    timestamp = str(cue.get("timestamp") or "").strip()
    tag_family = "question" if str(ai_tag or manual_tag).upper().startswith("Q") else "answer"
    conflict_id_source = json.dumps(
        [str(file_key or ""), participant, timestamp, tag_family, transcript_index],
        ensure_ascii=False,
    )
    conflict_id = hashlib.sha1(conflict_id_source.encode("utf-8")).hexdigest()[:16]
    return {
        "id": conflict_id,
        "type": "qa_tag_mismatch",
        "tagFamily": tag_family,
        "fileKey": file_key,
        "participant": participant,
        "segmentId": cue.get("segmentId"),
        "timestamp": timestamp,
        "transcriptIndex": transcript_index,
        "speaker": str(cue.get("speaker") or "").strip(),
        "cueText": str(cue.get("script") or "").strip(),
        "manualTag": manual_tag or "None",
        "aiSuggestedTag": ai_tag,
        "activeTag": manual_tag or "None",
        "status": "open",
    }


def _write_qna_tag_conflicts_payload(conflicts_path: str, conflicts: list[dict]) -> dict:
    payload = {
        "conflicts": conflicts,
        "summary": {
            "openCount": len(conflicts),
            "questionCount": sum(1 for item in conflicts if item.get("tagFamily") == "question"),
            "answerCount": sum(1 for item in conflicts if item.get("tagFamily") == "answer"),
        },
        "updatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    }
    _atomic_write_json(conflicts_path, payload)
    return payload


def _refresh_qna_tag_conflict_for_cue(
    file_key: str, content: dict, cue: dict, transcript_index: int,
) -> tuple[bool, dict | None]:
    """Normalize a saved manual choice and return any unresolved AI mismatch."""
    has_manual, manual_tag = _qna_manual_tag_state(cue)
    ai_tag = _normalize_qna_tag_value(cue.get("aiSuggestedTag"))
    had_conflict = "tagConflict" in cue or "tagConflictType" in cue
    if not has_manual:
        _clear_qna_conflict_fields(cue)
        return had_conflict, None

    changed = False
    normalized_manual = manual_tag or "None"
    if cue.get("manualTag") != normalized_manual:
        cue["manualTag"] = normalized_manual
        changed = True
    if cue.get("tagSource") != "manual":
        cue["tagSource"] = "manual"
        changed = True
    if cue.get("tag") != normalized_manual:
        cue["tag"] = normalized_manual
        changed = True

    if not ai_tag or ai_tag == manual_tag or _qna_resolution_matches(cue, manual_tag, ai_tag):
        _clear_qna_conflict_fields(cue)
        return changed or had_conflict, None

    conflict = _build_qna_tag_conflict_record(
        file_key, content, cue, transcript_index, manual_tag, ai_tag,
    )
    if cue.get("tagConflict") is not True:
        cue["tagConflict"] = True
        changed = True
    if cue.get("tagConflictType") != "qa_tag_mismatch":
        cue["tagConflictType"] = "qa_tag_mismatch"
        changed = True
    return changed, conflict


def _refresh_qna_tag_conflicts_for_path(transcript_path: str | None, conflicts_path: str | None = None) -> dict:
    if not transcript_path or not os.path.exists(transcript_path):
        payload = _empty_qna_tag_conflicts_payload()
        if conflicts_path:
            _write_qna_tag_conflicts_payload(conflicts_path, payload["conflicts"])
        return payload

    resolved_conflicts_path = conflicts_path or os.path.join(os.path.dirname(transcript_path), "TagConflicts.json")
    try:
        with open(transcript_path, "r", encoding="utf-8") as f:
            transcripts_payload = json.load(f)
    except Exception as e:
        print(f"[WARN] Could not refresh Q&A tag conflicts from {transcript_path}: {e}")
        return _empty_qna_tag_conflicts_payload()

    if not isinstance(transcripts_payload, dict):
        return _write_qna_tag_conflicts_payload(resolved_conflicts_path, [])

    conflicts: list[dict] = []
    changed = False
    for file_key, content in transcripts_payload.items():
        if not isinstance(content, dict) or not isinstance(content.get("transcript"), list):
            continue
        for transcript_index, cue in enumerate(content.get("transcript", [])):
            if not isinstance(cue, dict):
                continue
            cue_changed, conflict = _refresh_qna_tag_conflict_for_cue(
                file_key, content, cue, transcript_index,
            )
            if cue_changed:
                changed = True
            if conflict is not None:
                conflicts.append(conflict)

    if changed:
        _atomic_write_json(transcript_path, transcripts_payload)

    return _write_qna_tag_conflicts_payload(resolved_conflicts_path, conflicts)


def _find_qna_cue_for_update(disk_data, file_key, timestamp, participant="", segment_id=""):
    """Use stable IDs for new imports; accept unambiguous legacy timestamp updates."""
    if not isinstance(disk_data, dict):
        return None, None, None

    candidate_keys = list(disk_data)
    if file_key:
        candidate_keys = [
            key for key in candidate_keys
            if key == file_key or (isinstance(disk_data[key], dict) and disk_data[key].get("sourceFile") == file_key)
        ]
        if not candidate_keys:
            basename = os.path.basename(file_key.replace("\\", "/"))
            candidate_keys = [key for key in disk_data if os.path.basename(key) == basename]
    normalized_participant = normalize_participant_id(participant)
    matches = []
    for candidate_key in candidate_keys:
        content = disk_data[candidate_key]
        if not isinstance(content, dict):
            continue
        if normalized_participant and _processed_transcript_participant_id(candidate_key, content) != normalized_participant:
            continue
        for cue in content.get("transcript", []):
            if not isinstance(cue, dict):
                continue
            if segment_id:
                matches_cue = cue.get("segmentId") == segment_id
            else:
                matches_cue = bool(timestamp) and str(cue.get("timestamp") or "").strip() == str(timestamp).strip()
            if matches_cue:
                matches.append((candidate_key, content, cue))
    if len(matches) == 1:
        return matches[0]
    return None, None, None


def _processed_transcript_candidate_keys_for_participant(participant: str) -> set[str]:
    candidate_keys: set[str] = set()
    filemap = _load_filemap_payload(get_filemap_path())
    if not isinstance(filemap, dict):
        return candidate_keys

    for item in filemap.get("participants", []):
        if not isinstance(item, dict):
            continue
        if normalize_participant_id(item.get("participant")) != participant:
            continue

        transcript_info = item.get("transcript") if isinstance(item.get("transcript"), dict) else {}
        for raw_path in (
            transcript_info.get("relativePath"),
            transcript_info.get("originalFilename"),
        ):
            relative_path = str(raw_path or "").replace("\\", "/")
            basename = os.path.basename(relative_path)
            if not basename:
                continue
            candidate_keys.add(relative_path)
            candidate_keys.add(basename)
            stem, ext = os.path.splitext(basename)
            if ext.lower() == ".docx":
                candidate_keys.add(f"{stem}_from_docx.txt")
    return candidate_keys


def _processed_transcript_path_for_current_mode() -> tuple[str, str | None]:
    mode = session.get('mode', 'user')
    if mode == 'demo':
        return get_demo_processed_transcripts_path(session.get("current_project_id")), None
    return get_user_processed_transcripts_path(), None


# To save changes made in transcript mode
@app.route('/api/save_transcript_edit', methods=['POST'])
def save_transcript_edit():
    ensure_user_session_context()

    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "No data received"}), 400

    timestamp = data.get("timestamp")
    segment_id = data.get("segmentId")
    file_key = data.get("fileKey") or data.get("key") or ""
    new_text = data.get("newText")
    participant = data.get("participant")

    if not (segment_id or timestamp) or new_text is None or not participant:
        return jsonify({"error": "Missing fields"}), 400

    mode = session.get('mode', 'user')
    if mode == 'demo':
        return jsonify({"error": "Editing not allowed in demo mode"}), 403

    output_dir = get_user_project_processed_dir()
    transcript_file = os.path.join(output_dir, 'all_transcripts_processed.json')

    if not os.path.exists(transcript_file):
        return jsonify({"error": f"File not found: {transcript_file}"}), 404

    try:
        with open(transcript_file, 'r', encoding='utf-8') as f:
            transcript_data = json.load(f)
        matched_file_key, _, cue = _find_qna_cue_for_update(
            transcript_data, file_key, timestamp, participant, segment_id
        )
        if cue is None:
            return jsonify({"error": "The transcript segment was not found or is ambiguous. Reload and try again."}), 404
        old_text = cue.get("script") or ""
        matched_tag = cue.get("tag") or ""
        cue["script"] = new_text
        cue["textEditedByUser"] = True

        with open(transcript_file, 'w', encoding='utf-8') as f:
            json.dump(transcript_data, f, indent=4, ensure_ascii=False)

        return jsonify({"message": "Saved"}), 200

    except Exception as e:
        print(f"[save_transcript_edit] Error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route('/api/tag_speaker_role', methods=['POST'])
def tag_speaker_role():
    ensure_user_session_context()

    data = request.get_json(silent=True) or {}
    participant = normalize_participant_id(data.get("participant"))
    speaker_name = str(data.get("speakerName") or "").strip()
    target_speaker = _canonical_speaker_role_label(data.get("targetRole"))

    if not participant:
        return jsonify({"error": "Missing participant"}), 400
    if not speaker_name:
        return jsonify({"error": "Missing speaker name"}), 400
    if not target_speaker:
        return jsonify({"error": "Target role must be interviewer or participant"}), 400

    target_filepath, legacy_filepath = _processed_transcript_path_for_current_mode()

    try:
        loaded_from_legacy = False
        if os.path.exists(target_filepath):
            with open(target_filepath, 'r', encoding='utf-8') as f:
                transcript_data = json.load(f)
        else:
            return jsonify({"error": "Target transcript file not found on server."}), 404

        source_speaker_key = _normalize_speaker_role_name(speaker_name)
        candidate_file_keys = _processed_transcript_candidate_keys_for_participant(participant)
        updated_count = 0
        matched_file_keys = []

        for file_key, entry in transcript_data.items():
            entry_participant = _processed_transcript_participant_id(file_key, entry)
            matches_participant = (
                entry_participant == participant
                or (not entry_participant and file_key in candidate_file_keys)
            )
            if not matches_participant:
                continue
            cues = entry.get("transcript") if isinstance(entry, dict) else None
            if not isinstance(cues, list):
                continue

            file_updated = False
            for cue in cues:
                if not isinstance(cue, dict):
                    continue
                original_speaker = cue.get("speakerLabel") or cue.get("speaker")
                if _normalize_speaker_role_name(original_speaker) != source_speaker_key:
                    continue
                cue.setdefault("speakerLabel", original_speaker)
                cue["speakerRole"] = target_speaker.lower()
                cue["speakerRoleSource"] = "manual"
                cue["speaker"] = target_speaker
                updated_count += 1
                file_updated = True

            if file_updated:
                matched_file_keys.append(file_key)

        if updated_count == 0:
            return jsonify({"error": "No matching speaker labels found."}), 404

        os.makedirs(os.path.dirname(target_filepath), exist_ok=True)
        with open(target_filepath, 'w', encoding='utf-8') as f:
            json.dump(transcript_data, f, indent=4, ensure_ascii=False)

        return jsonify({
            "message": "Speaker role saved successfully.",
            "speaker": target_speaker,
            "updatedCount": updated_count,
            "fileKeys": matched_file_keys,
        }), 200

    except Exception as e:
        print(f"[tag_speaker_role] Error: {e}")
        return jsonify({"error": "Server error while saving speaker role"}), 500


# --- ENDPOINT FOR UPLOADING AUDIO FILES ---
@app.route('/upload_audio_file', methods=['POST'])
def upload_audio_file_route():

    ensure_user_session_context()

    if 'audio_file' not in request.files:
        return jsonify({"error": "No audio_file part"}), 400

    file = request.files['audio_file']
    # We get the relative path to preserve the folder structure
    client_relative_path = request.form.get('relativePath', file.filename)

    if file.filename == '':
        return jsonify({"error": "No file selected"}), 400

    # Security: Sanitize the path
    if ".." in client_relative_path or client_relative_path.startswith(("/", "\\")):
        return jsonify({"error": "Invalid relative path"}), 400

    allowed_audio_extensions = {'.mp3', '.wav', '.m4a', '.ogg', '.flac'}
    audio_extension = os.path.splitext(file.filename)[1].lower()
    if audio_extension not in allowed_audio_extensions:
        return jsonify({
            "error": "Unsupported audio file type. Use .mp3, .wav, .m4a, .ogg, or .flac."
        }), 400

    try:
        # The full path where the file will be saved
        # e.g., .../static/Uploaded_files/audio_storage/YourFolderName/P3.m4a
        mode = session.get("mode", "user")
        audio_base_dir = get_audio_storage_dir_for_mode(mode=mode)
        server_save_path = os.path.join(audio_base_dir, client_relative_path)

        os.makedirs(os.path.dirname(server_save_path), exist_ok=True)

        file.save(server_save_path)
        print(f"Saved audio file to: {server_save_path}")

        return jsonify({
            "message": "Audio file uploaded successfully.",
            "savedPath": client_relative_path
        }), 200

    except Exception as e:
        print(f"Error saving audio file {file.filename}: {e}")
        return jsonify({"error": "Server error during audio upload", "details": str(e)}), 500

@app.route('/serve_audio/<path:filepath>')
def serve_audio_file(filepath):
    mode = session.get('mode', 'user')
    relative_path = _sanitize_relative_path(filepath)
    if not relative_path:
        return jsonify({"error": "Invalid audio path"}), 400

    demo_project_dir = None
    if mode == 'demo':
        ensure_demo_assets()
        demo_project_id = session.get("current_project_id") or DEFAULT_DEMO_PROJECT_ID
        demo_project_dir = get_demo_project_dir(demo_project_id) or get_demo_project_dir(DEFAULT_DEMO_PROJECT_ID)
        # Keep active demo assets synced so fallback paths remain valid.
        if demo_project_dir:
            sync_demo_project_to_active_assets(demo_project_id)

    resolved_audio_path = _resolve_audio_path_for_mode(
        relative_path,
        mode,
        demo_project_dir=demo_project_dir,
    )
    if not resolved_audio_path:
        print(f"[WARN] Audio not found for '{relative_path}' in mode='{mode}'")
        return jsonify({"error": "Audio file not found"}), 404

    return send_from_directory(
        os.path.dirname(resolved_audio_path),
        os.path.basename(resolved_audio_path),
    )


# --- ROUTE TO DELETE A SPECIFIC UPLOADED FILE ---
@app.route('/delete_file', methods=['POST'])
def delete_file_route():
    ensure_user_session_context()

    data = request.get_json()
    file_type = data.get('fileType')
    relative_path = data.get('relativePath')

    if not file_type or not relative_path:
        return jsonify({"error": "Missing fileType or relativePath"}), 400

    # Security: Sanitize the path to prevent directory traversal attacks
    if ".." in relative_path or relative_path.startswith(("/", "\\")):
        return jsonify({"error": "Invalid file path"}), 400

    # Determine which base directory to use
    mode = session.get("mode", "user")
    if file_type == 'transcript':
        base_dir = get_transcript_storage_dir_for_mode(mode=mode)
    elif file_type == 'audio':
        base_dir = get_audio_storage_dir_for_mode(mode=mode)
    else:
        return jsonify({"error": "Invalid file type specified"}), 400

    # Construct the full, absolute path to the file
    full_path_to_file = os.path.join(base_dir, relative_path)

    try:
        if os.path.exists(full_path_to_file):
            size_bytes = os.path.getsize(full_path_to_file)
            os.remove(full_path_to_file)
            print(f"Successfully deleted file from server: {full_path_to_file}")
            return jsonify({"message": "File deleted successfully from server."}), 200
        else:
            print(f"File to delete not found on server: {full_path_to_file}")
            # Still return success to the client, as the file doesn't exist anyway
            return jsonify({"message": "File not found on server, but removed from client list."}), 200

    except Exception as e:
        print(f"Error deleting file {full_path_to_file}: {e}")
        return jsonify({"error": "Server error while deleting file", "details": str(e)}), 500


# API to create json
@app.route('/create_json', methods=['GET'])
def create_json_doc():
  result = transcriptProcessing.doc_processing()
  return result

# --- ROUTE TO START THE DEMO PROJECT ---
@app.route('/api/start_demo', methods=['POST'])
def start_demo():
    ensure_user_session_context()
    try:
        materialize_demo_project_for_current_user(DEFAULT_DEMO_PROJECT_ID)
    except Exception as e:
        print(f"[WARN] Could not prepare per-user demo project: {e}")
        return jsonify({"error": "Could not prepare demo project", "details": str(e)}), 500

    ensure_demo_route_context(DEFAULT_DEMO_PROJECT_ID, sync_assets=True)
    _store_theme_object_in_session(
        _ensure_demo_visualization_seed(DEFAULT_DEMO_PROJECT_ID),
        DEFAULT_DEMO_PROJECT_ID,
    )
    session['is_new_project'] = False
    print("--- DEMO PROJECT READY IN HIDDEN USER WORKSPACE ---")
    demo_demographics_object = {
        "options": [
            # You can add all possible options here, even if not chosen by default
            { "field": "age", "type": "Integer", "values": [] },
            { "field": "gender", "type": "Text", "values": ["Female", "Male"] },
            { "field": "ethnicity", "type": "Text", "values": ["White", "Mixed", "African American", "Asian"] },
            { "field": "maritalStatus", "type": "Text", "values": ["Married", "Single"] },
            { "field": "educationLevel", "type": "Text", "values": [] },
            { "field": "location", "type": "Text", "values": [] },
            { "field": "occupation", "type": "Text", "values": [] }
        ],
        # These are the fields that will be visible by default in the demo
        "chosenFields": ["age", "gender", "ethnicity", "maritalStatus"],
        "transcripts": []
    }
    session['demographicsObject'] = demo_demographics_object
    return redirect(demo_prefixed_path(url_for("fileManager")))
# ---END OF DEMO PROJECT ---


@app.route('/api/reset_demo', methods=['POST'])
def reset_demo():
    ensure_user_session_context()
    payload = request.get_json(silent=True) or {}
    demo_project_id = _safe_project_id(payload.get("demoProjectId") or DEFAULT_DEMO_PROJECT_ID)
    if not _is_demo_seed_project_id(demo_project_id):
        return _project_not_found_response()

    user_project_id = _user_demo_project_id(demo_project_id)
    project_root = os.path.join(
        _workspace_projects_root(session.get("user_workspace_key"), create=True),
        user_project_id,
    )
    backup_root = f"{project_root}.reset-backup-{uuid.uuid4().hex}"

    with _project_mutation_lock(user_project_id):
        moved_existing = False
        try:
            if os.path.exists(project_root):
                os.replace(project_root, backup_root)
                moved_existing = True
            materialize_demo_project_for_current_user(demo_project_id)
            next_revision = _advance_project_revision(user_project_id)
            if moved_existing and os.path.exists(backup_root):
                shutil.rmtree(backup_root)
        except Exception as reset_error:
            if os.path.exists(project_root):
                shutil.rmtree(project_root)
            if moved_existing and os.path.exists(backup_root):
                os.replace(backup_root, project_root)
            return jsonify({"error": "Could not reset demo project.", "details": str(reset_error)}), 500

    session["current_project_id"] = demo_project_id
    session["current_project_name"] = _demo_project_name_for_user(demo_project_id, _demo_project_def_for_id(demo_project_id))
    session["mode"] = "demo"
    _set_route_scope("demo")
    _clear_project_scoped_session_cache()
    return jsonify({
        "ok": True,
        "message": "Your demo project was reset.",
        "demoProjectId": demo_project_id,
        "userProjectId": user_project_id,
        "projectRevision": next_revision,
    }), 200


# --- API: Get current progress state for the local workspace ---
@app.route('/api/progress_state', methods=['GET'])
def progress_state():
    user_id = session.get('user_id')
    mode = session.get("mode", "user")
    project_id = session.get("current_project_id")
    status_path = _resolve_status_path_for_mode(mode, project_id)
    state = get_progress_for_user(user_id, project_id=project_id, mode=mode, status_path=status_path)
    return jsonify(state), 200


def _qna_request_context(payload=None):
    """Use the Transcript tab's destination even if another tab changed session mode."""
    payload = payload if isinstance(payload, dict) else {}
    mode = request.args.get("mode") or payload.get("mode") or session.get("mode", "user")
    if mode not in {"user", "demo"}:
        abort(400, description="Invalid project mode.")

    project_id = _safe_project_id(
        request.args.get("projectId") or payload.get("projectId") or session.get("current_project_id")
    )
    if mode == "user":
        project_ids = {
            project.get("projectId")
            for project in session.get("user_projects", [])
            if isinstance(project, dict)
        }
        if project_id not in project_ids:
            abort(404, description="The requested project is no longer available.")
    elif not _demo_project_def_for_id(project_id):
        abort(404, description="The requested demo project is not available.")
    return mode, project_id


@app.route('/api/tag_conflicts', methods=['GET'])
def tag_conflicts():
    ensure_user_session_context()

    mode, project_id = _qna_request_context()
    if mode == "demo":
        transcript_path = get_demo_processed_transcripts_path(project_id)
    else:
        transcript_path = get_user_processed_transcripts_path(project_id)

    with _project_mutation_lock(project_id):
        payload = _refresh_qna_tag_conflicts_for_path(
            transcript_path,
            _tag_conflicts_path_for_mode(mode, project_id),
        )
    participant = normalize_participant_id(request.args.get("participant"))
    if participant:
        conflicts = [
            conflict for conflict in payload.get("conflicts", [])
            if normalize_participant_id(conflict.get("participant")) == participant
        ]
        payload = {
            **payload,
            "conflicts": conflicts,
            "summary": {
                "openCount": len(conflicts),
                "questionCount": sum(1 for item in conflicts if item.get("tagFamily") == "question"),
                "answerCount": sum(1 for item in conflicts if item.get("tagFamily") == "answer"),
            },
        }
    return jsonify(payload), 200


@app.route('/api/resolve_qna_tag_conflict', methods=['POST'])
def resolve_qna_tag_conflict():
    ensure_user_session_context()

    payload = request.get_json(silent=True) or {}
    action = str(payload.get("action") or "").strip().lower()
    if action not in {"keep_manual", "use_ai", "keep_both", "dismiss"}:
        return jsonify({"error": "Invalid conflict resolution action."}), 400

    timestamp = str(payload.get("timestamp") or "").strip()
    segment_id = str(payload.get("segmentId") or "").strip()
    file_key = str(payload.get("fileKey") or payload.get("key") or "").strip()
    participant = normalize_participant_id(payload.get("participant"))
    if not (segment_id or timestamp):
        return jsonify({"error": "Missing transcript segment."}), 400

    mode, project_id = _qna_request_context(payload)
    if mode == "demo":
        target_filepath = get_demo_processed_transcripts_path(project_id)
    else:
        target_filepath = get_user_processed_transcripts_path(project_id)

    try:
        with _project_mutation_lock(project_id):
            if os.path.exists(target_filepath):
                with open(target_filepath, "r", encoding="utf-8") as f:
                    disk_data = json.load(f)
            else:
                return jsonify({"error": "Target transcript file not found on server."}), 404

            found_key, found_content, cue = _find_qna_cue_for_update(disk_data, file_key, timestamp, participant, segment_id)
            if not cue:
                return jsonify({"error": "Could not find the tagged transcript cue."}), 404

            previous_qna_state = qna_state(cue)

            manual_tag = _normalize_qna_tag_value(payload.get("manualTag")) or _normalize_qna_tag_value(cue.get("manualTag")) or _normalize_qna_tag_value(cue.get("tag"))
            ai_tag = _normalize_qna_tag_value(payload.get("aiSuggestedTag")) or _normalize_qna_tag_value(cue.get("aiSuggestedTag"))
            if action in {"use_ai", "keep_both"} and not ai_tag:
                return jsonify({"error": "Missing AI suggested tag for this action."}), 400
            if action == "keep_both" and not ai_tag.startswith("A"):
                return jsonify({"error": "Keep both is only available for answer tag conflicts."}), 400

            manual_tag = manual_tag or "None"
            now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

            if action == "use_ai":
                cue["tag"] = ai_tag
                cue["manualTag"] = ai_tag
                cue["tagSource"] = "manual"
                cue["aiSuggestedTag"] = ai_tag
                cue["tagUpdatedAt"] = now
                cue.pop("additionalTags", None)
                _clear_qna_resolution_fields(cue)
                _clear_qna_conflict_fields(cue)
            elif action == "keep_both":
                cue["tag"] = manual_tag
                cue["manualTag"] = manual_tag
                cue["tagSource"] = "manual"
                cue["aiSuggestedTag"] = ai_tag
                existing_additional_tags = []
                for value in cue.get("additionalTags", []) or []:
                    normalized_tag = _normalize_qna_tag_value(value)
                    if normalized_tag and normalized_tag not in existing_additional_tags and normalized_tag != manual_tag:
                        existing_additional_tags.append(normalized_tag)
                if ai_tag not in existing_additional_tags and ai_tag != manual_tag:
                    existing_additional_tags.append(ai_tag)
                cue["additionalTags"] = existing_additional_tags
                cue["tagUpdatedAt"] = now
                _mark_qna_conflict_resolved(cue, action, manual_tag, ai_tag)
            else:
                cue["tag"] = manual_tag
                cue["manualTag"] = manual_tag
                cue["tagSource"] = "manual"
                if ai_tag:
                    cue["aiSuggestedTag"] = ai_tag
                cue["tagUpdatedAt"] = now
                cue.pop("additionalTags", None)
                _mark_qna_conflict_resolved(cue, action, manual_tag, ai_tag)

            _atomic_write_json(target_filepath, disk_data)

            conflicts_payload = _refresh_qna_tag_conflicts_for_path(
                target_filepath,
                _tag_conflicts_path_for_mode(mode, project_id),
            )
        return jsonify({
            "message": "Q&A tag conflict resolved.",
            "cue": cue,
            "tagConflicts": conflicts_payload,
            "undoToken": qna_undo_token(payload, previous_qna_state, cue, mode, project_id),
        }), 200
    except Exception as e:
        print(f"Error resolving Q&A tag conflict: {e}")
        return jsonify({"error": "Server error while resolving tag conflict"}), 500


@app.route('/api/save_qna_tags', methods=['POST'])
def save_qna_tags():
    ensure_user_session_context()

    updated_transcripts = request.get_json(silent=True)
    if not updated_transcripts:
        return jsonify({"error": "No data received"}), 400

    key_to_update = updated_transcripts.get('fileKey') or updated_transcripts.get('key')
    timestamp_to_find = updated_transcripts.get('timestamp')
    segment_id = updated_transcripts.get('segmentId')
    participant = updated_transcripts.get('participant', '')
    new_tag_value = updated_transcripts.get('newTag')
    normalized_new_tag = _normalize_qna_tag_value(new_tag_value)
    stored_new_tag = normalized_new_tag or "None"

    if not key_to_update or not (segment_id or timestamp_to_find):
        return jsonify({"error": "Invalid data format from frontend."}), 400

    mode, project_id = _qna_request_context(updated_transcripts)

    if mode == 'demo':
        target_filepath = get_demo_processed_transcripts_path(project_id)
    else:
        target_filepath = get_user_processed_transcripts_path(project_id)

    try:
        with _project_mutation_lock(project_id):
            if os.path.exists(target_filepath):
                with open(target_filepath, 'r', encoding='utf-8') as f:
                    disk_data = json.load(f)
            else:
                return jsonify({"error": "Target transcript file not found on server."}), 404

            _, _, updated_cue = _find_qna_cue_for_update(
                disk_data, key_to_update, timestamp_to_find, participant, segment_id
            )
            if updated_cue is None:
                return jsonify({"error": "The transcript segment was not found or is ambiguous. Reload and try again."}), 404
            previous_qna_state = qna_state(updated_cue)
            old_tag_value = updated_cue.get('tag')
            has_manual_tag, _ = _qna_manual_tag_state(updated_cue)
            ai_suggested_tag = _normalize_qna_tag_value(updated_cue.get("aiSuggestedTag"))
            if not has_manual_tag and not ai_suggested_tag:
                ai_suggested_tag = _normalize_qna_tag_value(old_tag_value)
                if ai_suggested_tag:
                    updated_cue["aiSuggestedTag"] = ai_suggested_tag
            updated_cue['tag'] = stored_new_tag
            updated_cue['manualTag'] = stored_new_tag
            updated_cue['tagSource'] = "manual"
            updated_cue['tagUpdatedAt'] = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
            _clear_qna_resolution_fields(updated_cue)
            _clear_qna_conflict_fields(updated_cue)
            # Choosing a Q/A label is the user's final decision about the current
            # AI suggestion. A different suggestion from a later run can be reviewed.
            if ai_suggested_tag and ai_suggested_tag != normalized_new_tag:
                _mark_qna_conflict_resolved(updated_cue, "keep_manual", normalized_new_tag, ai_suggested_tag)
            updated_cue.pop("additionalTags", None)

            _atomic_write_json(target_filepath, disk_data)

            conflicts_payload = _refresh_qna_tag_conflicts_for_path(
                target_filepath,
                _tag_conflicts_path_for_mode(mode, project_id),
            )

        operation = "update"
        old_normalized_tag = _normalize_qna_tag_value(old_tag_value)
        if not old_normalized_tag and normalized_new_tag:
            operation = "add"
        elif old_normalized_tag and not normalized_new_tag:
            operation = "delete"
        return jsonify({
            "message": "Q&A tag saved successfully.",
            "cue": updated_cue,
            "tagConflicts": conflicts_payload,
            "undoToken": qna_undo_token(updated_transcripts, previous_qna_state, updated_cue, mode, project_id),
        }), 200

    except Exception as e:
        return jsonify({"error": "Server error while saving tag"}), 500


def register_demo_route_aliases():
    existing_rules = {rule.rule for rule in app.url_map.iter_rules()}
    source_rules = list(app.url_map.iter_rules())

    for rule in source_rules:
        if rule.endpoint == "static":
            continue
        if is_demo_prefixed_path(rule.rule):
            continue

        alias_rule = demo_prefixed_path(rule.rule)
        if alias_rule in existing_rules:
            continue

        endpoint_suffix = re.sub(r"[^a-zA-Z0-9_]+", "_", rule.rule).strip("_") or "root"
        endpoint_name_base = f"demo_alias__{rule.endpoint}__{endpoint_suffix}"
        endpoint_name = endpoint_name_base
        counter = 2
        while endpoint_name in app.view_functions:
            endpoint_name = f"{endpoint_name_base}_{counter}"
            counter += 1

        methods = sorted(m for m in rule.methods if m not in {"HEAD", "OPTIONS"})
        add_kwargs = {
            "rule": alias_rule,
            "endpoint": endpoint_name,
            "view_func": app.view_functions[rule.endpoint],
            # Accept both /demo and /demo/ for the root page. The public demo URL
            # has historically been shared with a trailing slash.
            "strict_slashes": False if rule.rule == "/" else rule.strict_slashes,
        }
        if methods:
            add_kwargs["methods"] = methods
        if rule.defaults:
            add_kwargs["defaults"] = rule.defaults

        app.add_url_rule(**add_kwargs)
        existing_rules.add(alias_rule)


# --- Function to orchestrate calling the external analysis scripts ---
def tag_questions_answers():
    """
    Orchestrates the server-side Q&A tagging pipeline using Qwen3.
    1. Tags interviewer questions.
    2. Tags participant answers.
    Returns True on success, False on failure.
    """
    print("\n--- [START] Qwen Q&A Tagging Pipeline ---")

    # 1. Check which mode the application is in.
    mode = session.get('mode', 'user')
    print(f"QA Pipeline running in '{mode}' mode.")

    try:
        project_id = session.get("current_project_id")
        runtime_dirs = _resolve_project_runtime_dirs(mode, project_id)
        qwen_qna = _build_qna_runtime(
            mode,
            project_id,
            processed_dir=runtime_dirs.get("processed_dir"),
            uploads_dir=runtime_dirs.get("uploads_dir"),
            intermediate_dir=runtime_dirs.get("intermediate_dir"),
        )
        file_map_for_job = None
        if mode != "demo":
            file_map_for_job = _load_filemap_payload(get_filemap_path()) or {"participants": []}
        _ensure_processed_transcripts_cover_uploads(
            mode=mode,
            project_id=project_id,
            input_directory=runtime_dirs.get("uploads_dir"),
            output_directory=runtime_dirs.get("processed_dir"),
            file_map=file_map_for_job,
        )
        # Step 1: Qwen question tagging
        print("\n[Step 1/2] Running Qwen question tagging...")
        qwen_qna.extract_interviewer_script()
        qwen_qna.tag_questions_batch(batch_size=14)
        qwen_qna.add_tagged_questions()
        _refresh_qna_tag_conflicts_for_path(qwen_qna.TRANSCRIPTS_JSON_PATH)

        # Step 2: Qwen answer tagging
        print("\n[Step 2/2] Running Qwen answer tagging...")
        qwen_qna.extract_questions_possible_answers()
        qwen_qna.tag_answer_batch(batch_size=14)
        qwen_qna.add_tagged_answers()
        _refresh_qna_tag_conflicts_for_path(qwen_qna.TRANSCRIPTS_JSON_PATH)

        print("\n--- [SUCCESS] Qwen Q&A Tagging Pipeline Complete ---")
        return True # Indicate overall success

    except Exception as e:
        import traceback
        print("--- [FAILED] Qwen Q&A Tagging Pipeline ---")
        print(f"An error occurred during the analysis pipeline: {e}")
        traceback.print_exc()
        return False

def _selected_themes_output_dir(mode: str | None = None, project_id: str | None = None) -> str:
    resolved_mode = mode or session.get('mode', 'user')
    resolved_project_id = project_id if project_id is not None else session.get("current_project_id")
    if resolved_mode == 'demo':
        return get_demo_project_outputs_dir(resolved_project_id)
    return get_user_project_processed_dir(resolved_project_id)


def _persist_selected_theme_payload(data, mode: str | None = None, project_id: str | None = None) -> str:
    if not isinstance(data, dict):
        raise ValueError("Selected theme payload must be a JSON object.")
    deletion_intent = _extract_manual_deletion_intent(data)
    raw_data = _strip_manual_deletion_intent_keys(data)
    raw_data.pop("projectRevision", None)
    output_dir = _selected_themes_output_dir(mode=mode, project_id=project_id)
    filepath = os.path.join(output_dir, 'SelectedThemes.json')
    os.makedirs(output_dir, exist_ok=True)
    existing_payload = _load_json_payload_if_exists(filepath, {"themes": []})
    if (
        isinstance(raw_data, dict)
        and "manualSelectionOptOuts" not in raw_data
        and isinstance(existing_payload, dict)
        and "manualSelectionOptOuts" in existing_payload
    ):
        raw_data = {
            **raw_data,
            "manualSelectionOptOuts": existing_payload.get("manualSelectionOptOuts"),
        }
    if (
        isinstance(raw_data, dict)
        and "archivedCodes" not in raw_data
        and isinstance(existing_payload, dict)
        and "archivedCodes" in existing_payload
    ):
        raw_data = {
            **raw_data,
            "archivedCodes": existing_payload.get("archivedCodes"),
        }
    data = _canonicalize_selected_theme_payload(raw_data)
    data = _merge_existing_manual_entries_for_save(
        data,
        existing_payload,
        output_dir,
        deletion_intent,
    )
    _atomic_write_json(filepath, data)

    if has_request_context() and isinstance(data.get("themes"), list):
        _store_theme_object_in_session(data, project_id)

    return filepath


def _theme_payload_action_metrics(payload: dict | None) -> dict:
    themes = payload.get("themes") if isinstance(payload, dict) else []
    if not isinstance(themes, list):
        themes = []

    theme_names = []
    code_map = {}
    for theme in themes:
        if not isinstance(theme, dict):
            continue
        theme_name = str(theme.get("themeName") or theme.get("theme") or theme.get("name") or "").strip()
        if not theme_name:
            continue
        theme_names.append(theme_name)
        theme_key = _safe_usage_log_key(theme_name, default="theme")
        words = theme.get("words") if isinstance(theme.get("words"), list) else []
        for word in words:
            identity = _build_theme_word_identity_key(word)
            word_text = word.get("word") if isinstance(word, dict) else word
            fallback_key = hashlib.sha1(str(word_text or "").encode("utf-8")).hexdigest()[:12]
            code_key = f"{theme_key}::{identity or fallback_key}"
            code_map[code_key] = {
                "themeName": theme_name,
                "text": _analysis_action_text_fingerprint(word_text, preview_length=120),
            }

    normalized_theme_names = sorted(set(theme_names), key=lambda value: value.lower())
    return {
        "themeNames": normalized_theme_names,
        "themeCount": len(normalized_theme_names),
        "codeMap": code_map,
        "codeCount": len(code_map),
    }


def _selected_theme_action_details(previous_payload: dict | None, next_payload: dict | None) -> dict:
    before = _theme_payload_action_metrics(previous_payload)
    after = _theme_payload_action_metrics(next_payload)
    before_themes = set(before["themeNames"])
    after_themes = set(after["themeNames"])
    before_codes = set(before["codeMap"].keys())
    after_codes = set(after["codeMap"].keys())
    added_code_keys = sorted(after_codes - before_codes)
    removed_code_keys = sorted(before_codes - after_codes)

    def archived_theme_names(payload):
        archived = payload.get("archivedCodes") if isinstance(payload, dict) else []
        if not isinstance(archived, list):
            return set()
        return {
            str(theme.get("themeName") or theme.get("theme") or theme.get("name") or "").strip()
            for theme in archived
            if isinstance(theme, dict)
            and str(theme.get("themeName") or theme.get("theme") or theme.get("name") or "").strip()
        }

    before_archived = archived_theme_names(previous_payload)
    after_archived = archived_theme_names(next_payload)

    return {
        "themeCountBefore": before["themeCount"],
        "themeCountAfter": after["themeCount"],
        "codeCountBefore": before["codeCount"],
        "codeCountAfter": after["codeCount"],
        "addedThemes": sorted(after_themes - before_themes, key=lambda value: value.lower()),
        "removedThemes": sorted(before_themes - after_themes, key=lambda value: value.lower()),
        "addedCodeCount": len(added_code_keys),
        "removedCodeCount": len(removed_code_keys),
        "addedCodeExamples": [after["codeMap"][key] for key in added_code_keys[:5]],
        "removedCodeExamples": [before["codeMap"][key] for key in removed_code_keys[:5]],
        "archivedThemes": sorted(after_archived - before_archived, key=lambda value: value.lower()),
        "restoredThemes": sorted(before_archived - after_archived, key=lambda value: value.lower()),
    }


def _quote_archive_action_details(previous_payload: dict | None, next_payload: dict | None) -> dict:
    def quote_map(payload):
        quotes = payload.get("deletedQuotes") if isinstance(payload, dict) else []
        if not isinstance(quotes, list):
            quotes = []
        result = {}
        for quote in quotes:
            if not isinstance(quote, dict):
                continue
            theme_name = str(quote.get("themeName") or "").strip()
            text = quote.get("word")
            identity = _build_theme_word_identity_key(quote) or hashlib.sha1(
                f"{theme_name}::{text}".encode("utf-8")
            ).hexdigest()[:12]
            result[f"{_safe_usage_log_key(theme_name, default='theme')}::{identity}"] = {
                "themeName": theme_name,
                "participant": quote.get("participant"),
                "tag": quote.get("tag"),
                "timestamp": quote.get("timestamp"),
                "text": _analysis_action_text_fingerprint(text, preview_length=120),
            }
        return result

    before = quote_map(previous_payload)
    after = quote_map(next_payload)
    before_keys = set(before.keys())
    after_keys = set(after.keys())
    added_keys = sorted(after_keys - before_keys)
    removed_keys = sorted(before_keys - after_keys)
    return {
        "deletedQuoteCountBefore": len(before),
        "deletedQuoteCountAfter": len(after),
        "archivedQuoteCount": len(added_keys),
        "restoredQuoteCount": len(removed_keys),
        "archivedQuoteExamples": [after[key] for key in added_keys[:5]],
        "restoredQuoteExamples": [before[key] for key in removed_keys[:5]],
    }


@app.route('/data-policy')
def data_policy():
    return render_template('dataPolicy.html')


# Import routes only after their shared helpers above are ready.
from routes import register_blueprints

register_blueprints(app)
register_demo_route_aliases()


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=settings.port, debug=settings.debug, threaded=True)
