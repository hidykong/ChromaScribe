"""Process-local job state and thread-local workspace ownership.

These objects are shared by routes and workers within one process.
Job execution and project-aware progress orchestration remain in app.py.
"""

import json
import os
import time
from threading import Lock, local as ThreadLocal


progress_store = {}
progress_lock = Lock()
running_jobs = set()
running_jobs_lock = Lock()
similar_excerpt_tasks = {}
similar_excerpt_jobs = set()
similar_excerpt_job_tasks = {}
similar_excerpt_cancel_events = {}
similar_excerpt_jobs_lock = Lock()
similar_excerpt_update_lock = Lock()
TAGGING_PROGRESS_STALE_SECONDS = 2 * 60 * 60
TAGGING_PROGRESS_HEARTBEAT_SECONDS = 30
_workspace_context_state = ThreadLocal()


def _thread_workspace_key() -> str | None:
    key = getattr(_workspace_context_state, "workspace_key", None)
    if isinstance(key, str) and key.strip():
        return key.strip()
    return None


def _set_thread_workspace_key(workspace_key: str | None) -> str | None:
    previous_key = _thread_workspace_key()
    if workspace_key:
        _workspace_context_state.workspace_key = str(workspace_key).strip()
    elif hasattr(_workspace_context_state, "workspace_key"):
        delattr(_workspace_context_state, "workspace_key")
    return previous_key


def _restore_thread_workspace_key(previous_key: str | None):
    if previous_key:
        _workspace_context_state.workspace_key = previous_key
    elif hasattr(_workspace_context_state, "workspace_key"):
        delattr(_workspace_context_state, "workspace_key")


def _persist_progress_state_file(status_path: str | None, user_id: str, stage: int, message: str, extra: dict | None = None):
    if not status_path:
        return
    try:
        os.makedirs(os.path.dirname(status_path), exist_ok=True)
        payload = {
            "user_id": user_id,
            "stage": stage,
            "message": message,
            "updated_at": int(time.time()),
        }
        if extra:
            payload.update(extra)
        with open(status_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
    except Exception as e:
        print(f"[WARN] Could not persist progress state at {status_path}: {e}")


def _load_progress_state_file(status_path: str | None) -> dict | None:
    if not status_path or not os.path.exists(status_path):
        return None
    try:
        with open(status_path, "r", encoding="utf-8") as f:
            payload = json.load(f) or {}
        if isinstance(payload, dict):
            return payload
    except Exception as e:
        print(f"[WARN] Could not read progress state at {status_path}: {e}")
    return None
