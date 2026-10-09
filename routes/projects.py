"""Projects routes, using the current main behavior.

Independent helpers live in services; project/session workflows remain in app.py.
app.py registers these blueprints after defining their remaining dependencies.
"""

import json
import os
import re

from flask import (
    Blueprint,
    jsonify,
    request,
    session,
)

from app import (
    DEMO_PROJECT_DEFS,
    _best_existing_filemap_path_for_project,
    _clear_project_runtime_storage,
    _clear_project_scoped_session_cache_if_changed,
    _count_files_recursive,
    _ensure_demo_visualization_seed,
    _ensure_project_storage_meta,
    _extract_project_number,
    _find_project_name_conflict,
    _is_demo_seed_project_id,
    _is_user_demo_project_id,
    _mark_project_workflow_step,
    _normalize_progress_payload,
    _persist_workspace_projects,
    _progress_store_key,
    _project_awaits_first_upload,
    _project_workflow_state,
    _record_user_project_name,
    _request_project_id,
    _resolve_status_path_for_mode,
    _safe_project_id,
    _session_project_is_authorized,
    _set_route_scope,
    _store_theme_object_in_session,
    delete_user_project_storage,
    ensure_demo_assets,
    ensure_user_session_context,
    get_demo_project_dir,
    get_filemap_path_for_project,
    get_progress_for_user,
    get_project_context,
    get_user_output_json_path,
    get_user_project_base_dir,
    get_user_project_processed_dir,
    materialize_demo_project_for_current_user,
    read_demo_project_manifest,
    set_current_project,
    start_new_project,
)

from services.background_jobs import (
    progress_lock,
    progress_store,
)

from services.storage import (
    _json_file_has_content,
)


projects_bp = Blueprint("projects", __name__)


@projects_bp.route('/api/project/set', methods=['POST'])
def set_project_context():
    ensure_user_session_context()
    payload = request.get_json(silent=True) or {}
    project_name = payload.get('projectName') or payload.get('name')
    project_id = payload.get('projectId')
    target_project_id = _safe_project_id(project_id or session.get("current_project_id"))

    if project_name is not None:
        project_name = str(project_name).strip()
        if project_name and _project_awaits_first_upload(target_project_id):
            duplicate_project = _find_project_name_conflict(project_name, exclude_project_id=target_project_id)
            if duplicate_project:
                duplicate_name = str(duplicate_project.get("projectName") or "").strip() or "that project name"
                return jsonify({
                    "error": f"Project name '{project_name}' already exists.",
                    "warning": f"Project name '{duplicate_name}' already exists. Choose a different name.",
                    "duplicateProjectId": duplicate_project.get("projectId"),
                    "duplicateProjectName": duplicate_name,
                }), 409

    if project_id:
        safe_project_id = target_project_id
        previous_project_id = session.get("current_project_id")
        previous_mode = session.get("mode", "user")
        existing_project = None
        for project in session.get("user_projects", []):
            if project.get("projectId") == safe_project_id:
                existing_project = project
                break
        if not existing_project:
            return jsonify({"error": "Project not found for this session."}), 404
        session['current_project_id'] = safe_project_id
        _clear_project_scoped_session_cache_if_changed(
            previous_project_id,
            previous_mode,
            safe_project_id,
            session.get("mode", "user"),
        )
    if project_name is not None:
        project_name = str(project_name).strip()
        resolved_project_id = session.get("current_project_id")
        _record_user_project_name(resolved_project_id, project_name or "Untitled Project")
        _mark_project_workflow_step(
            resolved_project_id,
            "project_named" if project_name else "project_name_pending",
            {
                "projectName": project_name or "Untitled Project",
                "awaitingFirstUpload": _project_awaits_first_upload(resolved_project_id),
                "nextStep": "upload_files" if project_name else "name_project",
            },
            project_name_confirmed=bool(project_name),
        )
    else:
        _persist_workspace_projects(
            session.get("user_projects", []),
            session.get("user_workspace_key"),
            current_project_id=session.get("current_project_id"),
        )

    return jsonify(get_project_context()), 200


@projects_bp.route('/api/projects/list', methods=['GET'])
def list_projects():
    ensure_user_session_context()
    mode = session.get("mode", "user")

    def extract_participant_code(raw_value) -> str | None:
        text = str(raw_value or "").strip()
        if not text:
            return None

        patterns = [
            r"\bparticipant\s*0*(\d+)\b",
            r"(?<![a-z0-9])p\s*0*(\d+)(?![a-z0-9])",
            r"(?<![a-z0-9])pt\s*0*(\d+)(?![a-z0-9])",
        ]
        for pattern in patterns:
            match = re.search(pattern, text, flags=re.IGNORECASE)
            if match:
                return f"P{int(match.group(1))}"
        return None

    def summarize_filemap(filemap_path: str | None) -> dict:
        summary = {
            "participantsCount": 0,
            "transcriptsCount": 0,
            "audioCount": 0,
        }
        if not filemap_path or not os.path.exists(filemap_path):
            return summary

        try:
            with open(filemap_path, "r", encoding="utf-8") as f:
                filemap = json.load(f)
            participants = filemap.get("participants", [])
            summary["participantsCount"] = len(participants) if isinstance(participants, list) else 0

            for participant in participants if isinstance(participants, list) else []:
                transcript_entry = participant.get("transcript") if isinstance(participant, dict) else None
                audio_entry = participant.get("audio") if isinstance(participant, dict) else None

                if transcript_entry:
                    if isinstance(transcript_entry, list):
                        if len(transcript_entry) > 0:
                            summary["transcriptsCount"] += 1
                    else:
                        summary["transcriptsCount"] += 1
                if audio_entry:
                    if isinstance(audio_entry, list):
                        if len(audio_entry) > 0:
                            summary["audioCount"] += 1
                    else:
                        summary["audioCount"] += 1
        except Exception as e:
            print(f"[WARN] Could not read project filemap {filemap_path}: {e}")

        return summary

    def scan_asset_directory(root_dir: str | None, excluded_dirs: set[str] | None = None) -> tuple[int, set[str], int]:
        file_count = 0
        matched_participants: set[str] = set()
        unmatched_file_count = 0

        if not root_dir or not os.path.isdir(root_dir):
            return file_count, matched_participants, unmatched_file_count

        excluded = {name for name in (excluded_dirs or set()) if isinstance(name, str) and name}
        for current_root, dirnames, filenames in os.walk(root_dir):
            dirnames[:] = [
                dirname for dirname in dirnames
                if not dirname.startswith(".") and dirname not in excluded
            ]
            for filename in filenames:
                if not filename or filename.startswith("."):
                    continue
                file_count += 1
                participant_id = extract_participant_code(filename) or extract_participant_code(
                    os.path.join(current_root, filename)
                )
                if participant_id:
                    matched_participants.add(participant_id)
                else:
                    unmatched_file_count += 1

        return file_count, matched_participants, unmatched_file_count

    def processed_transcript_participants(processed_path: str | None) -> set[str]:
        participant_ids: set[str] = set()
        if not processed_path or not os.path.exists(processed_path):
            return participant_ids

        try:
            with open(processed_path, "r", encoding="utf-8") as f:
                processed_payload = json.load(f)
        except Exception as e:
            print(f"[WARN] Could not read processed transcripts {processed_path}: {e}")
            return participant_ids

        if not isinstance(processed_payload, dict):
            return participant_ids

        for key, entry in processed_payload.items():
            participant_id = None
            if isinstance(entry, dict):
                participant_id = (
                    extract_participant_code(entry.get("participant"))
                    or extract_participant_code(entry.get("audiofile"))
                    or extract_participant_code(key)
                )
                if not participant_id and isinstance(entry.get("transcript"), list):
                    for speech in entry.get("transcript", []):
                        if not isinstance(speech, dict):
                            continue
                        participant_id = (
                            extract_participant_code(speech.get("participant"))
                            or extract_participant_code(speech.get("speaker"))
                        )
                        if participant_id:
                            break
            else:
                participant_id = extract_participant_code(key)

            if participant_id:
                participant_ids.add(participant_id)

        return participant_ids

    def count_project_assets(mode_name: str, project_id: str | None = None, project_dir: str | None = None, filemap_path: str | None = None):
        filemap_summary = summarize_filemap(filemap_path)

        if mode_name == "demo":
            transcript_root = os.path.join(project_dir, "uploads", "transcripts") if project_dir else ""
            audio_root = os.path.join(project_dir, "uploads", "audio") if project_dir else ""
            processed_path = os.path.join(project_dir, "outputs", "all_transcripts_processed.json") if project_dir else ""
        else:
            base_dir = get_user_project_base_dir(project_id)
            meta = _ensure_project_storage_meta(project_id)
            transcript_root = os.path.join(base_dir, meta.get("uploads_dir", "inputs"))
            audio_root = os.path.join(transcript_root, "audio_storage")
            processed_path = os.path.join(base_dir, meta.get("outputs_dir", "outputs"), "all_transcripts_processed.json")

        _, transcript_participants, unmatched_transcript_files = scan_asset_directory(
            transcript_root,
            excluded_dirs={"audio_storage", "Questions"}
        )
        _, audio_participants, unmatched_audio_files = scan_asset_directory(audio_root)

        transcripts_count = len(transcript_participants) + unmatched_transcript_files
        audio_count = len(audio_participants) + unmatched_audio_files

        fallback_processed_participants: set[str] = set()
        if transcripts_count == 0:
            fallback_processed_participants = processed_transcript_participants(processed_path)
            if fallback_processed_participants:
                transcripts_count = len(fallback_processed_participants)

        participant_count = len(transcript_participants | audio_participants)
        asset_bound = max(transcripts_count, audio_count)
        if participant_count == 0 and fallback_processed_participants:
            participant_count = len(fallback_processed_participants)
        if asset_bound > 0 and filemap_summary["participantsCount"] > 0:
            participant_count = max(
                participant_count,
                min(filemap_summary["participantsCount"], asset_bound)
            )
        if participant_count == 0:
            participant_count = asset_bound

        return participant_count, transcripts_count, audio_count

    ensure_demo_assets()
    demo_projects = []
    user_projects = []

    for project_def in DEMO_PROJECT_DEFS:
        project_id = project_def.get("project_id")
        project_dir = get_demo_project_dir(project_id)
        if not project_dir:
            continue
        manifest = read_demo_project_manifest(project_dir)
        filemap_path = os.path.join(project_dir, "filemap.json")
        participants_count, transcripts_count, audio_count = count_project_assets(
            "demo",
            project_id=project_id,
            project_dir=project_dir,
            filemap_path=filemap_path
        )
        outputs_count = 0
        outputs_dir = os.path.join(project_dir, "outputs")
        if os.path.exists(outputs_dir):
            for _, _, files in os.walk(outputs_dir):
                outputs_count += len(files)

        demo_projects.append({
            "projectId": manifest.get("project_id", project_id),
            "projectName": manifest.get("project_name") or project_def.get("project_name"),
            "projectNumber": _extract_project_number({
                "projectId": manifest.get("project_id", project_id),
                "projectName": manifest.get("project_name") or project_def.get("project_name"),
            }),
            "folderName": manifest.get("folder_name", project_id),
            "createdAt": manifest.get("created_at"),
            "customName": False,
            "participantsCount": participants_count,
            "transcriptsCount": transcripts_count,
            "audioCount": audio_count,
            "outputsCount": outputs_count,
            "progress": {
                "stage": 4,
                "message": "Demo data ready",
                "running": False,
                "themesReady": True,
            }
        })
    demo_projects.sort(key=lambda p: p.get("createdAt") or "")

    for project in session.get("user_projects", []):
        project_id = project.get("projectId")
        if _is_user_demo_project_id(project_id):
            continue
        project_name = project.get("projectName")
        filemap_path = _best_existing_filemap_path_for_project(project_id)
        participants_count, transcripts_count, audio_count = count_project_assets(
            "user",
            project_id=project_id,
            filemap_path=filemap_path
        )
        outputs_count = 0
        output_ready = False
        try:
            outputs_dir = get_user_project_processed_dir(project_id)
            outputs_count = _count_files_recursive(outputs_dir)
            output_ready = _json_file_has_content(get_user_output_json_path(project_id))
        except Exception as e:
            print(f"[WARN] Could not inspect outputs for project {project_id}: {e}")

        status_path = _resolve_status_path_for_mode("user", project_id)
        progress_state = get_progress_for_user(
            session.get("user_id"),
            project_id=project_id,
            mode="user",
            status_path=status_path
        )
        normalized_progress = _normalize_progress_payload(progress_state, output_ready=output_ready)
        project_progress = _project_workflow_state(project_id)
        user_projects.append({
            "projectId": project_id,
            "projectName": project_name,
            "projectNumber": _extract_project_number(project),
            "folderName": project_id,
            "createdAt": None,
            "customName": True,
            "participantsCount": participants_count,
            "transcriptsCount": transcripts_count,
            "audioCount": audio_count,
            "outputsCount": outputs_count,
            "progress": normalized_progress,
            "projectProgress": project_progress,
            "projectNameConfirmed": bool(project_progress.get("projectNameConfirmed")),
        })

    projects = demo_projects + user_projects
    return jsonify({
        "projects": projects,
        "demoProjects": demo_projects,
        "userProjects": user_projects,
        "currentProjectId": session.get("current_project_id"),
        "workspaceKey": session.get("user_workspace_key"),
        "userKey": session.get("user_key"),
        "mode": mode,
    }), 200


@projects_bp.route('/api/projects/delete', methods=['POST'])
def delete_project():
    ensure_user_session_context()

    payload = request.get_json(silent=True) or {}
    project_id = payload.get("projectId")
    if not project_id:
        return jsonify({"error": "Missing projectId"}), 400
    if get_demo_project_dir(project_id):
        return jsonify({"error": "Demo projects cannot be deleted"}), 400

    safe_project_id = _safe_project_id(project_id)
    user_projects = session.get("user_projects", [])
    target_project = None
    for project in user_projects:
        if isinstance(project, dict) and project.get("projectId") == safe_project_id:
            target_project = project
            break

    if not target_project:
        return jsonify({"error": "Project not found"}), 404

    removed_paths = delete_user_project_storage(safe_project_id)
    updated_projects = [
        project for project in user_projects
        if isinstance(project, dict) and project.get("projectId") != safe_project_id
    ]
    session["user_projects"] = updated_projects
    _persist_workspace_projects(
        updated_projects,
        session.get("user_workspace_key"),
        current_project_id=session.get("current_project_id"),
    )

    with progress_lock:
        progress_store.pop(
            _progress_store_key(session.get("user_id"), project_id=safe_project_id, mode="user"),
            None
        )

    replacement_project_id = None
    if not updated_projects:
        session.pop('themeObject', None)
        session.pop('demographicsObject', None)
        session.pop('FileMap_MatchedData', None)
        session.pop('current_project_id', None)
        session.pop('current_project_name', None)
        session['mode'] = 'user'
        _set_route_scope("user")
        session['is_new_project'] = False
    elif session.get("mode", "user") != "demo" and session.get("current_project_id") == safe_project_id:
        replacement_project = updated_projects[0]
        replacement_project_id = replacement_project.get("projectId")
        replacement_project_name = replacement_project.get("projectName")
        set_current_project(replacement_project_id, replacement_project_name, "user")
        _ensure_project_storage_meta(replacement_project_id)
        replacement_filemap = get_filemap_path_for_project(replacement_project_id)
        session['is_new_project'] = _project_awaits_first_upload(replacement_project_id) or not (
            replacement_filemap and os.path.exists(replacement_filemap)
        )
        session['themeObject'] = {}

    _persist_workspace_projects(
        session.get("user_projects", []),
        session.get("user_workspace_key"),
        current_project_id=session.get("current_project_id"),
    )

    return jsonify({
        "message": "Project deleted",
        "deletedProjectId": safe_project_id,
        "replacementProjectId": replacement_project_id,
        "removedPaths": removed_paths,
        "projectContext": get_project_context(),
        "projects": session.get("user_projects", []),
    }), 200


@projects_bp.route('/api/projects/rename', methods=['POST'])
def rename_project():
    ensure_user_session_context()

    payload = request.get_json(silent=True) or {}
    project_id = payload.get("projectId")
    project_name = str(payload.get("projectName") or payload.get("name") or "").strip()

    if not project_id:
        return jsonify({"error": "Missing projectId"}), 400
    if not project_name:
        return jsonify({"error": "Project name cannot be empty."}), 400
    if get_demo_project_dir(project_id):
        return jsonify({"error": "Demo projects cannot be renamed"}), 400

    safe_project_id = _safe_project_id(project_id)
    projects = session.get("user_projects", [])
    target_project = None
    for project in projects:
        if isinstance(project, dict) and _safe_project_id(project.get("projectId")) == safe_project_id:
            target_project = project
            break

    if not target_project:
        return jsonify({"error": "Project not found"}), 404

    duplicate_project = _find_project_name_conflict(project_name, exclude_project_id=safe_project_id)
    if duplicate_project:
        duplicate_name = str(duplicate_project.get("projectName") or "").strip() or "that project name"
        return jsonify({
            "error": f"Project name '{project_name}' already exists.",
            "warning": f"Project name '{duplicate_name}' already exists. Choose a different name.",
            "duplicateProjectId": duplicate_project.get("projectId"),
            "duplicateProjectName": duplicate_name,
        }), 409

    _record_user_project_name(safe_project_id, project_name)
    return jsonify({
        "message": "Project renamed",
        "project": {
            "projectId": safe_project_id,
            "projectName": project_name,
        },
        "projectContext": get_project_context(),
        "projects": session.get("user_projects", []),
    }), 200


@projects_bp.route('/api/projects/select', methods=['POST'])
def select_project():
    ensure_user_session_context()
    previous_mode = session.get("mode", "user")
    payload = request.get_json(silent=True) or {}
    project_id = payload.get("projectId")
    safe_project_id = _safe_project_id(project_id)
    project_name = payload.get("projectName") or payload.get("name")
    if not project_id:
        return jsonify({"error": "Missing projectId"}), 400

    if _is_demo_seed_project_id(project_id):
        try:
            user_demo_project_id, user_demo_project_name = materialize_demo_project_for_current_user(project_id)
        except Exception as e:
            return jsonify({"error": "Could not prepare demo project", "details": str(e)}), 500
        output_path = get_user_output_json_path(user_demo_project_id)
        if os.path.exists(output_path):
            _store_theme_object_in_session(
                _ensure_demo_visualization_seed(project_id, output_dir=get_user_project_processed_dir(user_demo_project_id)),
                user_demo_project_id,
            )
        else:
            session['themeObject'] = {}
        session['is_new_project'] = False
        return jsonify({
            "message": "Demo project copied to your workspace",
            "sourceDemoProjectId": project_id,
            "userProjectId": user_demo_project_id,
            "userProjectName": user_demo_project_name,
            "projectContext": get_project_context()
        }), 200

    previous_project_id = session.get("current_project_id")
    previous_mode = session.get("mode", "user")
    projects = session.get("user_projects", [])
    existing_project = None
    for project in projects:
        if project.get("projectId") == safe_project_id:
            existing_project = project
            break
    if not existing_project:
        return jsonify({"error": "Project not found for this session."}), 404
    session['current_project_id'] = safe_project_id
    session['mode'] = 'user'
    _set_route_scope("user")
    _clear_project_scoped_session_cache_if_changed(
        previous_project_id,
        previous_mode,
        safe_project_id,
        "user",
    )

    if project_name:
        session['current_project_name'] = project_name
        existing_project["projectName"] = project_name
    else:
        session['current_project_name'] = existing_project.get("projectName", "Project")
    _record_user_project_name(safe_project_id, session.get("current_project_name"))
    _ensure_project_storage_meta(safe_project_id)
    _persist_workspace_projects(
        session.get("user_projects", []),
        session.get("user_workspace_key"),
        current_project_id=session.get("current_project_id"),
    )
    filemap_path = get_filemap_path_for_project(safe_project_id)
    session['is_new_project'] = _project_awaits_first_upload(safe_project_id) or not (
        filemap_path and os.path.exists(filemap_path)
    )
    session['themeObject'] = {}
    if previous_mode == "demo" and session['is_new_project']:
        session['themeObject'] = {}
    return jsonify({
        "message": "Project selected",
        "projectContext": get_project_context()
    }), 200


@projects_bp.route('/api/maintenance/project_runtime/clear', methods=['POST'])
def api_clear_project_runtime():
    ensure_user_session_context()
    payload = request.get_json(silent=True) or {}
    mode = str(payload.get("mode") or session.get("mode", "user")).strip()
    if mode == "demo":
        return jsonify({"error": "Clear the materialized project, not the shared demo seed."}), 400
    project_id = _request_project_id(session.get("current_project_id"), payload)
    if not _session_project_is_authorized(project_id):
        return jsonify({"error": "Project not found."}), 404
    cleanup = _clear_project_runtime_storage(project_id, payload, mode="user")
    return jsonify({
        "ok": True,
        **cleanup,
        "projectContext": get_project_context(),
    }), 200


@projects_bp.route('/api/check_project_state', methods=['GET'])
def check_project_state():
    if 'user' in session:
        ensure_user_session_context()
    # This route checks for the flag and then immediately removes it.
    # This ensures it only triggers a clear action once.
    is_new = session.pop('is_new_project', False) # Defaults to False if not found
    print(f"Checking project state. Is new project? {is_new}")
    project_context = get_project_context()
    project_progress = project_context.get("projectProgress") or {}
    return jsonify({
        "isNewProject": is_new,
        "projectContext": project_context,
        "projectProgress": project_progress,
        "projectNameConfirmed": bool(project_progress.get("projectNameConfirmed")),
        "awaitingFirstUpload": bool(project_progress.get("awaitingFirstUpload")),
    })


@projects_bp.route('/api/prepare_new_project', methods=['POST'])
def prepare_new_project():
    # This route's only job is to clear the session for a fresh start.
    session.pop('demographicsObject', None)
    session.pop('FileMap_MatchedData', None) # Clear any old file maps
    session.pop('themeObject', None)
    session.pop('mode', None)
    _set_route_scope("user")
    start_new_project()
    print("--- PREPARING FOR NEW PROJECT: Session cleared ---")
    return jsonify({"message": "Ready for new project.", "projectContext": get_project_context()}), 200
