"""Themes routes, using the current main behavior.

Independent helpers live in services; project/session workflows remain in app.py.
app.py registers these blueprints after defining their remaining dependencies.
"""

import json
import os
from pathlib import Path
from threading import Thread

from flask import (
    Blueprint,
    Response,
    jsonify,
    redirect,
    render_template,
    request,
    session,
    stream_with_context,
    url_for,
)

from app import (
    _advance_project_revision,
    _build_qna_runtime,
    _build_qwen_runtime,
    _canonicalize_selected_theme_payload,
    _current_user_project_requires_upload_notice,
    _ensure_demo_visualization_seed,
    _ensure_processed_transcripts_cover_uploads,
    _filter_theme_payload_for_visualization_display,
    _find_theme_key_in_output,
    _generation_job_key,
    _get_code_groups_path,
    _get_workspace_preferences,
    _has_selected_theme_state,
    _has_theme_payload,
    _load_filemap_payload,
    _load_selected_theme_payload,
    _load_user_project_theme_object,
    _mark_ai_generated_code_payload_applied,
    _mark_tagging_run_complete,
    _mark_tagging_run_started,
    _merge_generated_quotes_into_theme_payload,
    _merge_theme_payloads_preserving_manual,
    _migrate_manual_selection_theme_name,
    _normalize_code_groups_storage_payload,
    _normalize_group_list,
    _normalize_group_path,
    _normalize_theme_lookup_name,
    _output_json_path_for_mode_project,
    _persist_selected_theme_payload,
    _project_mutation_lock,
    _project_name_for_id,
    _project_not_found_response,
    _project_revision,
    _record_user_project_name,
    _refresh_qna_tag_conflicts_for_path,
    _refresh_session_theme_object_from_output,
    _render_upload_required_page,
    _request_project_id,
    _resolve_mode_output_json_path,
    _resolve_project_runtime_dirs,
    _resolve_status_path_for_mode,
    _safe_project_id,
    _seed_ai_generated_output_from_theme_payload,
    _selected_theme_action_details,
    _selected_themes_file_exists,
    _selected_themes_output_dir,
    _session_project_is_authorized,
    _session_theme_object_is_summary,
    _set_workspace_preference,
    _start_tagging_progress_heartbeat,
    _store_theme_object_in_session,
    _tagging_input_signature,
    _tagging_progress_extra,
    _tagging_start_state,
    _themes_txt_path,
    _update_groups_in_session_theme_object,
    _visualization_theme_payload,
    build_theme_object_from_output,
    ensure_demo_assets,
    ensure_user_session_context,
    generate_themes_background,
    get_demo_output_json_path,
    get_demo_project_outputs_dir,
    get_filemap_path_for_project,
    get_progress_for_user,
    get_project_context,
    get_user_output_json_path,
    get_user_project_base_dir,
    get_user_project_processed_dir,
    load_theme_titles_from_output_json,
    read_themes,
    remove_existing_themes_file,
    set_current_project,
    set_progress,
    write_topics_qwen,
)

from services.background_jobs import (
    running_jobs,
    running_jobs_lock,
)

from services.storage import (
    _json_file_has_content,
    _load_json_payload_if_exists,
    _project_relative_storage_path,
)


themes_bp = Blueprint("themes", __name__)


@themes_bp.route('/themes', methods=['GET'])
def themes():
    ensure_user_session_context()
    mode = session.get('mode', 'user')
    if _current_user_project_requires_upload_notice():
        return _render_upload_required_page(
            active_tab="themes-tab",
            active_icon="/static/images/Enable_Themes.png",
        )
    if mode == 'demo':
        ensure_demo_assets()
        seeded_theme_payload = _ensure_demo_visualization_seed(session.get("current_project_id"))
        if _has_theme_payload(seeded_theme_payload):
            _store_theme_object_in_session(seeded_theme_payload, session.get("current_project_id"))
        if not session.get('themeObject'):
            _store_theme_object_in_session(
                _load_selected_theme_payload(get_demo_project_outputs_dir(session.get("current_project_id"))),
                session.get("current_project_id"),
            )
    return render_template('themes.html', mode=mode)


@themes_bp.route('/themes/edit', methods=['GET', 'POST'])
def edit():
    ensure_user_session_context()
    mode = session.get('mode', 'user')
    if request.method == 'POST':
        themeObject = request.json or {}
        project_id = _request_project_id(session.get("current_project_id"), themeObject if isinstance(themeObject, dict) else None)
        safe_project_id = _safe_project_id(project_id)
        if mode == "user" and project_id and safe_project_id:
            set_current_project(safe_project_id, _project_name_for_id(safe_project_id), "user")
        updatedThemes = themeObject.get('themes', [])
        use_session_theme = safe_project_id == _safe_project_id(session.get("current_project_id"))
        session_theme_object = session.get('themeObject', {})
        previous_theme_object = (
            session_theme_object
            if use_session_theme
            and isinstance(session_theme_object, dict)
            and not _session_theme_object_is_summary(session_theme_object)
            else _load_selected_theme_payload(_selected_themes_output_dir(mode=mode, project_id=project_id))
        )
        _store_theme_object_in_session({'themes': updatedThemes}, safe_project_id)
        if isinstance(updatedThemes, list):
            try:
                matching_payload = {
                    key: value
                    for key, value in themeObject.items()
                    if key not in {"projectId", "project_id"}
                }
                matching_payload["themes"] = updatedThemes
                matching_payload["selectionStage"] = "matching_excerpts"
                matching_payload.setdefault("selectionSource", "theme_selection")
                _persist_selected_theme_payload(
                    matching_payload,
                    mode=mode,
                    project_id=project_id,
                )
            except Exception as e:
                print(f"[WARN] Could not persist matching excerpt selection: {e}")

        return '', 204  # No Content response for AJAX call

    if mode == 'demo':
        ensure_demo_assets()
        selected_theme_payload = _load_selected_theme_payload(
            get_demo_project_outputs_dir(session.get("current_project_id"))
        )
        if _has_selected_theme_state(selected_theme_payload):
            themeObject = selected_theme_payload
        elif not session.get('themeObject'):
            themeObject = build_theme_object_from_output(get_demo_output_json_path(session.get("current_project_id")))
        else:
            themeObject = build_theme_object_from_output(get_demo_output_json_path(session.get("current_project_id")))
        _store_theme_object_in_session(themeObject, session.get("current_project_id"))
    else:
        project_id = _request_project_id(session.get("current_project_id"))
        safe_project_id = _safe_project_id(project_id)
        if project_id and safe_project_id != _safe_project_id(session.get("current_project_id")):
            set_current_project(safe_project_id, _project_name_for_id(safe_project_id), "user")
        themeObject = _load_user_project_theme_object(project_id, use_session=False, display_for_visualization=True)
        _store_theme_object_in_session(themeObject, safe_project_id)

    # Sanitize quote text before passing to template
    if isinstance(themeObject, dict):
        for theme in themeObject.get('themes', []):
            if isinstance(theme, dict) and 'words' in theme:
                for word in theme['words']:
                    if isinstance(word, dict) and 'word' in word:
                        word['word'] = word['word'].strip().strip('"\'')
    return render_template('editThemes.html', themeObject=themeObject, mode=mode)


@themes_bp.route('/themes/archive', methods=['GET'])
def edit_archive():
    if 'user' not in session:
        return redirect(url_for('home'))
    ensure_user_session_context()
    mode = session.get("mode", "user")
    project_id = _request_project_id(session.get("current_project_id"))
    if mode == "demo":
        theme_object = _load_selected_theme_payload(get_demo_project_outputs_dir(project_id))
        if not _has_theme_payload(theme_object):
            theme_object = build_theme_object_from_output(get_demo_output_json_path(project_id))
    else:
        theme_object = _load_user_project_theme_object(project_id, use_session=False)
    _store_theme_object_in_session(theme_object, project_id)
    return render_template('editThemes.html', themeObject=theme_object)


@themes_bp.route('/api/themes', methods=['GET'])
def api_get_themes():
    ensure_user_session_context()
    mode = session.get('mode', 'user')
    project_id = _request_project_id(session.get("current_project_id"))
    themeObject = session.get('themeObject', {}) or {}
    has_session_themes = _has_theme_payload(themeObject) and not _session_theme_object_is_summary(themeObject)
    if mode == 'demo':
        ensure_demo_assets()
        seeded_theme_payload = _ensure_demo_visualization_seed(project_id)
        if _has_theme_payload(seeded_theme_payload):
            themeObject = seeded_theme_payload
            if _safe_project_id(project_id) == _safe_project_id(session.get("current_project_id")):
                _store_theme_object_in_session(themeObject, project_id)
        elif not has_session_themes:
            themeObject = build_theme_object_from_output(get_demo_output_json_path(project_id))
            if _safe_project_id(project_id) == _safe_project_id(session.get("current_project_id")):
                _store_theme_object_in_session(themeObject, project_id)
    else:
        use_session_theme = _safe_project_id(project_id) == _safe_project_id(session.get("current_project_id"))
        themeObject = _load_user_project_theme_object(project_id, use_session=False, display_for_visualization=True)
        if use_session_theme and _has_theme_payload(themeObject):
            _store_theme_object_in_session(themeObject, project_id)
    return jsonify(themeObject)


@themes_bp.route('/api/themes/clear', methods=['POST'])
def api_clear_themes():
    session['themeObject'] = {}  # Set themeObject to an empty dictionary
    session.pop('demographicsObject', None)
    session.pop('FileMap_MatchedData', None)
    if request.is_json:
        payload = request.get_json(silent=True) or {}
        project_name = payload.get('projectName')
        if project_name:
            _record_user_project_name(session.get("current_project_id"), project_name)
    session['is_new_project'] = True
    return jsonify({
        "message": "Theme object emptied",
        "themeObject": session['themeObject'],
        "projectContext": get_project_context()
    }), 200


@themes_bp.route('/api/themes_edit_onboarding', methods=['GET', 'POST'])
def themes_edit_onboarding():
    ensure_user_session_context()

    preference_key = "themes_edit_onboarding_seen"
    if request.method == 'POST':
        payload = request.get_json(silent=True) or {}
        seen = bool(payload.get("seen", True))
        _set_workspace_preference(preference_key, seen)
        return jsonify({"seen": seen}), 200

    preferences = _get_workspace_preferences()
    return jsonify({"seen": bool(preferences.get(preference_key, False))}), 200


@themes_bp.route('/api/get_code_groups', methods=['GET'])
def api_get_code_groups():
    ensure_user_session_context()

    mode = session.get("mode", "user")
    project_id = _request_project_id(session.get("current_project_id"))
    groups_filepath = _get_code_groups_path(project_id=project_id, mode=mode)
    try:
        if not os.path.exists(groups_filepath):
            if request.args.get("includeMeta") == "1":
                return jsonify({"groups": [], "meta": {}})
            return jsonify([])
        with open(groups_filepath, 'r', encoding='utf-8') as f:
            payload = json.load(f)
        normalized, meta = _normalize_code_groups_storage_payload(payload)
        if request.args.get("includeMeta") == "1":
            return jsonify({"groups": normalized, "meta": meta})
        return jsonify(normalized)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@themes_bp.route('/api/save_code_groups', methods=['POST'])
def api_save_code_groups():
    ensure_user_session_context()

    request_payload = request.get_json(silent=True)
    if not isinstance(request_payload, (list, dict)):
        return jsonify({"error": "Expected a JSON array or object of group names."}), 400

    mode = session.get("mode", "user")
    project_id = _request_project_id(session.get("current_project_id"), request_payload)
    cleaned_groups, submitted_meta = _normalize_code_groups_storage_payload(request_payload)

    groups_filepath = _get_code_groups_path(project_id=project_id, mode=mode)
    if mode == "demo":
        output_filepath = get_demo_output_json_path(project_id)
    else:
        output_filepath = get_user_output_json_path(project_id)

    try:
        old_groups_list = []
        old_meta = {}
        if os.path.exists(groups_filepath):
            with open(groups_filepath, 'r', encoding='utf-8') as f:
                existing = json.load(f)
                old_groups_list, old_meta = _normalize_code_groups_storage_payload(existing)

        deleted_groups = set(old_groups_list) - set(cleaned_groups)
        next_meta = {}
        for group_name in cleaned_groups:
            next_meta[group_name] = {
                **old_meta.get(group_name, {}),
                **submitted_meta.get(group_name, {}),
            }

        if deleted_groups and os.path.exists(output_filepath):
            with open(output_filepath, 'r', encoding='utf-8') as f:
                output_data = json.load(f)

            if isinstance(output_data, dict):
                for theme_key, theme_payload in output_data.items():
                    if not isinstance(theme_payload, dict):
                        continue
                    groups = theme_payload.get('groups')
                    if not isinstance(groups, list):
                        continue
                    output_data[theme_key]['groups'] = [g for g in groups if g not in deleted_groups]

                with open(output_filepath, 'w', encoding='utf-8') as f:
                    json.dump(output_data, f, indent=2)

        os.makedirs(os.path.dirname(groups_filepath), exist_ok=True)
        with open(groups_filepath, 'w', encoding='utf-8') as f:
            if isinstance(request_payload, dict):
                json.dump({"groups": cleaned_groups, "meta": next_meta}, f, indent=2, ensure_ascii=False)
            else:
                json.dump(cleaned_groups, f, indent=2, ensure_ascii=False)

        _refresh_session_theme_object_from_output(output_filepath)
        return jsonify({"message": "Code groups saved and assignments updated successfully."}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@themes_bp.route('/api/rename_theme', methods=['POST'])
def api_rename_theme():
    ensure_user_session_context()

    payload = request.get_json(silent=True) or {}
    project_id = _request_project_id(session.get("current_project_id"), payload)
    old_name = str(payload.get("oldName") or "").strip()
    new_name = str(payload.get("newName") or "").strip()

    if not old_name or not new_name:
        return jsonify({"error": "oldName and newName are required"}), 400

    normalized_old = _normalize_theme_lookup_name(old_name)
    normalized_new = _normalize_theme_lookup_name(new_name)
    if not normalized_old or not normalized_new:
        return jsonify({"error": "Invalid theme names provided"}), 400

    if normalized_old == normalized_new and old_name == new_name:
        return jsonify({
            "message": "Theme name unchanged.",
            "updatedOutput": False,
            "updatedSession": False
        }), 200

    # Prevent duplicates within current session state.
    session_theme_object = session.get('themeObject')
    if isinstance(session_theme_object, dict) and isinstance(session_theme_object.get("themes"), list):
        for theme in session_theme_object.get("themes", []):
            if not isinstance(theme, dict):
                continue
            existing = _normalize_theme_lookup_name(theme.get("themeName"))
            if existing == normalized_new and existing != normalized_old:
                return jsonify({"error": f"Theme '{new_name}' already exists."}), 409

    mode = session.get("mode", "user")
    output_filepath = _output_json_path_for_mode_project(mode=mode, project_id=project_id)
    updated_output = False
    updated_session = False
    updated_selected_themes = False

    try:
        if os.path.exists(output_filepath):
            with open(output_filepath, 'r', encoding='utf-8') as f:
                output_data = json.load(f)

            if isinstance(output_data, dict):
                old_key = _find_theme_key_in_output(output_data, old_name)
                if old_key:
                    existing_new_key = _find_theme_key_in_output(output_data, new_name)
                    if (
                        existing_new_key
                        and _normalize_theme_lookup_name(existing_new_key) != normalized_old
                    ):
                        return jsonify({"error": f"Theme '{new_name}' already exists in ai_generated.json."}), 409

                    old_payload = output_data.pop(old_key)
                    output_data[new_name] = old_payload

                    os.makedirs(os.path.dirname(output_filepath), exist_ok=True)
                    with open(output_filepath, 'w', encoding='utf-8') as f:
                        json.dump(output_data, f, indent=2)
                    updated_output = True
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    theme_object = session.get('themeObject')
    if _safe_project_id(project_id) == _safe_project_id(session.get("current_project_id")) and isinstance(theme_object, dict):
        themes = theme_object.get('themes')
        if isinstance(themes, list):
            for theme in themes:
                if not isinstance(theme, dict):
                    continue
                if _normalize_theme_lookup_name(theme.get("themeName")) == normalized_old:
                    theme["themeName"] = new_name
                    updated_session = True
            if updated_session:
                session['themeObject'] = theme_object

    try:
        selected_dir = _selected_themes_output_dir(mode=mode, project_id=project_id)
        selected_path = os.path.join(selected_dir, "SelectedThemes.json")
        selected_payload = _load_json_payload_if_exists(selected_path, {"themes": []})
        if isinstance(selected_payload, dict) and isinstance(selected_payload.get("themes"), list):
            for theme in selected_payload.get("themes", []):
                if not isinstance(theme, dict):
                    continue
                if _normalize_theme_lookup_name(theme.get("themeName")) == normalized_old:
                    theme["themeName"] = new_name
                    updated_selected_themes = True
            if updated_selected_themes:
                selected_payload["manualSelectionOptOuts"] = _migrate_manual_selection_theme_name(
                    selected_payload,
                    old_name,
                    new_name,
                )
                selected_payload["manualDeletionIntent"] = {"themes": [old_name]}
                _persist_selected_theme_payload(selected_payload, mode=mode, project_id=project_id)
    except Exception as e:
        print(f"[WARN] Could not rename theme in SelectedThemes.json: {e}")

    if not updated_output and not updated_session and not updated_selected_themes:
        return jsonify({"error": f"Theme '{old_name}' not found."}), 404

    return jsonify({
        "message": "Theme renamed successfully.",
        "updatedOutput": updated_output,
        "updatedSession": updated_session,
        "updatedSelectedThemes": updated_selected_themes
    }), 200


@themes_bp.route('/api/save_theme_groups', methods=['POST'])
def api_save_theme_groups():
    ensure_user_session_context()

    data = request.get_json(silent=True) or {}
    project_id = _request_project_id(session.get("current_project_id"), data)
    theme_name = str(data.get('themeName') or "").strip()
    if not theme_name:
        return jsonify({"error": "themeName is required"}), 400

    groups = _normalize_group_list(data.get('groups'))
    mode = session.get("mode", "user")
    output_filepath = _output_json_path_for_mode_project(mode=mode, project_id=project_id)

    updated_output = False
    updated_session = False

    try:
        if os.path.exists(output_filepath):
            with open(output_filepath, 'r', encoding='utf-8') as f:
                output_data = json.load(f)
            if isinstance(output_data, dict):
                key_to_update = _find_theme_key_in_output(output_data, theme_name)
                if key_to_update:
                    payload = output_data.get(key_to_update)
                    if not isinstance(payload, dict):
                        payload = {}
                    payload['groups'] = list(groups)
                    output_data[key_to_update] = payload
                    os.makedirs(os.path.dirname(output_filepath), exist_ok=True)
                    with open(output_filepath, 'w', encoding='utf-8') as f:
                        json.dump(output_data, f, indent=2)
                    updated_output = True
                    _refresh_session_theme_object_from_output(output_filepath)

        if not updated_output and _safe_project_id(project_id) == _safe_project_id(session.get("current_project_id")):
            updated_session = _update_groups_in_session_theme_object(theme_name, groups)

        if not updated_output and not updated_session:
            return jsonify({"error": f"Theme '{theme_name}' not found."}), 404

        return jsonify({
            "message": "Theme groups saved.",
            "savedToOutput": updated_output,
            "savedToSession": updated_session or updated_output
        }), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@themes_bp.route('/api/assign_code_to_group', methods=['POST'])
def api_assign_code_to_group():
    ensure_user_session_context()

    data = request.get_json(silent=True) or {}
    project_id = _request_project_id(session.get("current_project_id"), data)
    theme_name = data.get('themeName')
    group_name = _normalize_group_path(data.get('groupName'))
    if not theme_name:
        return jsonify({"error": "themeName is required"}), 400

    mode = session.get("mode", "user")
    output_filepath = _output_json_path_for_mode_project(mode=mode, project_id=project_id)
    try:
        if not os.path.exists(output_filepath):
            return jsonify({"error": "ai_generated.json not found"}), 404
        with open(output_filepath, 'r', encoding='utf-8') as f:
            output_data = json.load(f)

        key_to_update = _find_theme_key_in_output(output_data, theme_name)
        if not key_to_update:
            return jsonify({"error": f"Theme '{theme_name}' not found in ai_generated.json"}), 404

        output_data[key_to_update]['groups'] = [group_name] if group_name else []
        os.makedirs(os.path.dirname(output_filepath), exist_ok=True)
        with open(output_filepath, 'w', encoding='utf-8') as f:
            json.dump(output_data, f, indent=2)
        _refresh_session_theme_object_from_output(output_filepath)
        return jsonify({"message": f"Assigned '{group_name}' to '{key_to_update}'."}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@themes_bp.route('/api/add_group_to_code', methods=['POST'])
def api_add_group_to_code():
    ensure_user_session_context()

    data = request.get_json(silent=True) or {}
    theme_name = data.get('themeName')
    group_name = _normalize_group_path(data.get('groupName'))
    if not theme_name or not group_name:
        return jsonify({"error": "themeName and groupName are required"}), 400

    output_filepath = _resolve_mode_output_json_path()
    try:
        if not os.path.exists(output_filepath):
            return jsonify({"error": "ai_generated.json not found"}), 404
        with open(output_filepath, 'r', encoding='utf-8') as f:
            output_data = json.load(f)

        key_to_update = _find_theme_key_in_output(output_data, theme_name)
        if not key_to_update:
            return jsonify({"error": f"Theme '{theme_name}' not found."}), 404

        if 'groups' not in output_data[key_to_update] or not isinstance(output_data[key_to_update]['groups'], list):
            output_data[key_to_update]['groups'] = []
        if group_name not in output_data[key_to_update]['groups']:
            output_data[key_to_update]['groups'].append(group_name)

        with open(output_filepath, 'w', encoding='utf-8') as f:
            json.dump(output_data, f, indent=2)
        _refresh_session_theme_object_from_output(output_filepath)
        return jsonify({"message": "Group added successfully."}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@themes_bp.route('/api/remove_group_from_code', methods=['POST'])
def api_remove_group_from_code():
    ensure_user_session_context()

    data = request.get_json(silent=True) or {}
    theme_name = data.get('themeName')
    group_name = _normalize_group_path(data.get('groupName'))
    if not theme_name or not group_name:
        return jsonify({"error": "themeName and groupName are required"}), 400

    output_filepath = _resolve_mode_output_json_path()
    try:
        if not os.path.exists(output_filepath):
            return jsonify({"error": "ai_generated.json not found"}), 404
        with open(output_filepath, 'r', encoding='utf-8') as f:
            output_data = json.load(f)

        key_to_update = _find_theme_key_in_output(output_data, theme_name)
        if not key_to_update:
            return jsonify({"error": f"Theme '{theme_name}' not found."}), 404

        groups = output_data[key_to_update].get('groups')
        if not isinstance(groups, list):
            return jsonify({"error": f"Theme '{theme_name}' has no groups."}), 404

        output_data[key_to_update]['groups'] = [g for g in groups if g != group_name]
        with open(output_filepath, 'w', encoding='utf-8') as f:
            json.dump(output_data, f, indent=2)
        _refresh_session_theme_object_from_output(output_filepath)
        return jsonify({"message": "Group removed successfully."}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@themes_bp.route("/create_themes", methods=["POST", "GET"])
def create_themes():
    ensure_user_session_context()

    request_payload = request.get_json(silent=True) or {}
    user_id = session['user_id']
    mode = session.get("mode", "user")
    project_id = _request_project_id(session.get("current_project_id"), request_payload)
    status_path = _resolve_status_path_for_mode(mode, project_id)

    # GET is used by EventSource clients and streams progress incrementally.
    if request.method == "GET":
        def generate():
            job_key = _generation_job_key(user_id, project_id=project_id, mode=mode)
            runtime_dirs = _resolve_project_runtime_dirs(mode, project_id)
            file_map_for_job = None
            if mode != "demo":
                file_map_for_job = _load_filemap_payload(get_filemap_path_for_project(project_id)) or {"participants": []}
            input_signature = _tagging_input_signature(
                mode=mode,
                project_id=project_id,
                uploads_dir=runtime_dirs.get("uploads_dir"),
                file_map=file_map_for_job,
            )
            progress_extra = _tagging_progress_extra(input_signature)
            if job_key:
                progress_extra["jobKey"] = job_key
            start_state = _tagging_start_state(
                user_id,
                mode,
                project_id,
                status_path,
                input_signature,
                job_key,
            )
            if start_state.get("status") == "already_running":
                progress_payload = start_state.get("progress") or {}
                yield f"data: {json.dumps({'stage': progress_payload.get('stage', 0), 'message': progress_payload.get('message', 'Already running'), 'status': 'already_running'})}\n\n"
                return
            if start_state.get("status") == "up_to_date":
                progress_payload = start_state.get("progress") or {}
                themes = progress_payload.get("themes") if isinstance(progress_payload.get("themes"), list) else []
                yield f"data: {json.dumps({'done': True, 'stage': 4, 'message': 'Complete', 'status': 'up_to_date', 'themes': themes})}\n\n"
                return

            with running_jobs_lock:
                if job_key in running_jobs:
                    yield f"data: {json.dumps({'stage': 0, 'message': 'Already running', 'status': 'already_running'})}\n\n"
                    return
                running_jobs.add(job_key)
            if mode != "demo":
                _mark_tagging_run_started(project_id, input_signature, job_key=job_key)
            heartbeat_stop = None
            try:
                heartbeat_stop = _start_tagging_progress_heartbeat(user_id, project_id, mode, status_path)
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
                _ensure_processed_transcripts_cover_uploads(
                    mode=mode,
                    project_id=project_id,
                    input_directory=runtime_dirs.get("uploads_dir"),
                    output_directory=runtime_dirs.get("processed_dir"),
                    file_map=file_map_for_job,
                    user_id=user_id,
                    status_path=status_path,
                    progress_extra=progress_extra,
                )
                set_progress(user_id, 1, "Current State: Tagging Questions", extra=progress_extra, project_id=project_id, mode=mode, status_path=status_path)
                qwen_qna.extract_interviewer_script()
                qwen_qna.tag_questions_batch(batch_size=14)
                qwen_qna.add_tagged_questions()
                _refresh_qna_tag_conflicts_for_path(qwen_qna.TRANSCRIPTS_JSON_PATH)
                yield f"data: {json.dumps({'stage': 1, 'message': 'Tagging Questions'})}\n\n"

                set_progress(user_id, 2, "Current State: Tagging Answers", extra=progress_extra, project_id=project_id, mode=mode, status_path=status_path)
                qwen_qna.extract_questions_possible_answers()
                qwen_qna.tag_answer_batch(batch_size=14)
                qwen_qna.add_tagged_answers()
                _refresh_qna_tag_conflicts_for_path(qwen_qna.TRANSCRIPTS_JSON_PATH)
                qwen.extract_answers_by_tag()
                yield f"data: {json.dumps({'stage': 2, 'message': 'Tagging Answers'})}\n\n"

                set_progress(user_id, 3, "Current State: Generating Themes", extra=progress_extra, project_id=project_id, mode=mode, status_path=status_path)
                yield f"data: {json.dumps({'stage': 3, 'message': 'Generating Themes'})}\n\n"

                topics = qwen.qwenModel()
                themes = write_topics_qwen(topics, project_id=project_id, mode=mode)
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
                    _mark_tagging_run_complete(project_id, input_signature)
                yield f"data: {json.dumps({'done': True, 'stage': 4, 'message': 'Complete', 'themes': themes})}\n\n"
            except Exception as e:
                set_progress(user_id, -1, f"Error: {str(e)}", extra=progress_extra, project_id=project_id, mode=mode, status_path=status_path)
                error_payload = json.dumps({"error": str(e), "stage": -1, "message": "Error"})
                yield f"data: {error_payload}\n\n"
            finally:
                if heartbeat_stop:
                    heartbeat_stop.set()
                with running_jobs_lock:
                    running_jobs.discard(job_key)

        return Response(stream_with_context(generate()), mimetype='text/event-stream')

    # POST starts background processing for polling clients.
    job_key = _generation_job_key(user_id, project_id=project_id, mode=mode)
    runtime_dirs = _resolve_project_runtime_dirs(mode, project_id)
    processed_dir = runtime_dirs.get("processed_dir")
    uploads_dir = runtime_dirs.get("uploads_dir")
    intermediate_dir = runtime_dirs.get("intermediate_dir")
    file_map_for_job = None
    if mode != "demo":
        file_map_for_job = _load_filemap_payload(get_filemap_path_for_project(project_id)) or {"participants": []}
    input_signature = _tagging_input_signature(
        mode=mode,
        project_id=project_id,
        uploads_dir=uploads_dir,
        file_map=file_map_for_job,
    )
    progress_extra = _tagging_progress_extra(input_signature)
    if job_key:
        progress_extra["jobKey"] = job_key
    start_state = _tagging_start_state(
        user_id,
        mode,
        project_id,
        status_path,
        input_signature,
        job_key,
    )
    if start_state.get("status") == "already_running":
        return jsonify({
            "status": "already_running",
            "projectId": project_id,
            "jobKey": job_key,
            "progress": start_state.get("progress"),
            "inputChanged": start_state.get("inputChanged", False),
        }), 200
    if start_state.get("status") == "up_to_date":
        return jsonify({
            "status": "up_to_date",
            "projectId": project_id,
            "jobKey": job_key,
            "progress": start_state.get("progress"),
            "inputChanged": False,
        }), 200

    with running_jobs_lock:
        if job_key in running_jobs:
            return jsonify({
                "status": "already_running",
                "projectId": project_id,
                "jobKey": job_key,
                "progress": get_progress_for_user(user_id, project_id=project_id, mode=mode, status_path=status_path),
            }), 200
        running_jobs.add(job_key)
    if mode != "demo":
        _mark_tagging_run_started(project_id, input_signature, job_key=job_key)
    set_progress(user_id, 0, "Started", extra=progress_extra, project_id=project_id, mode=mode, status_path=status_path)
    thread = Thread(
        target=generate_themes_background,
        args=(user_id, mode, project_id, processed_dir, uploads_dir, intermediate_dir, status_path, job_key, file_map_for_job, input_signature, session.get("user_workspace_key")),
        daemon=True,
    )
    thread.start()
    return jsonify({"status": "started", "projectId": project_id, "jobKey": job_key}), 202


@themes_bp.route('/demo_themes', methods=['POST', 'GET'])
def demo_themes():
  print("Demo themes")
  ensure_demo_assets()
  themes = load_theme_titles_from_output_json(get_demo_output_json_path(session.get("current_project_id")))

  # Keep backward-compatible local theme cache file for any old UI code paths.
  if themes:
    write_topics_qwen(themes, project_id=session.get("current_project_id"), mode="demo")
    return jsonify(themes)

  themes_path = Path(_themes_txt_path(project_id=session.get("current_project_id"), mode="demo"))
  if themes_path.is_file():
    return jsonify(read_themes(project_id=session.get("current_project_id"), mode="demo"))
  return jsonify([])


@themes_bp.route('/api/save_selected_themes', methods=['POST'])
def save_selected_themes():
    ensure_user_session_context()

    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "No data received"}), 400
    mode = session.get('mode', 'user')
    project_id = _request_project_id(session.get("current_project_id"), data if isinstance(data, dict) else None)
    if not _session_project_is_authorized(project_id):
        return _project_not_found_response()

    try:
        with _project_mutation_lock(project_id):
            current_revision = _project_revision(project_id)
            submitted_revision = data.get("projectRevision")
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

            output_dir = _selected_themes_output_dir(
                mode=mode,
                project_id=project_id,
            )
            previous_payload = _load_json_payload_if_exists(
                os.path.join(output_dir, 'SelectedThemes.json'),
                {"themes": []},
            )
            filepath = _persist_selected_theme_payload(
                data,
                mode=mode,
                project_id=project_id,
            )
            persisted_payload = _load_json_payload_if_exists(filepath, {"themes": []})
            next_revision = _advance_project_revision(project_id)
        action_details = _selected_theme_action_details(previous_payload, persisted_payload)
        operation = "create" if action_details["themeCountBefore"] == 0 and action_details["themeCountAfter"] > 0 else "update"
        if len(action_details["removedThemes"]) > 0 and not action_details["addedThemes"]:
            operation = "delete"
        if action_details["removedCodeCount"] > 0 and action_details["addedCodeCount"] == 0:
            operation = "delete"
        elif action_details["addedCodeCount"] > 0 and action_details["removedCodeCount"] == 0 and operation != "create":
            operation = "add"
        if action_details["archivedThemes"]:
            operation = "archive"
        elif action_details["restoredThemes"]:
            operation = "restore"
        print(f"SelectedThemes saved to: {filepath}")
        return jsonify({"message": "Saved successfully.", "projectRevision": next_revision}), 200
    except Exception as e:
        print(f"Error saving SelectedThemes: {e}")
        return jsonify({"error": "Server error", "details": str(e)}), 500


@themes_bp.route('/api/load_selected_themes', methods=['GET'])
def load_selected_themes():
    ensure_user_session_context()

    mode = session.get('mode', 'user')
    project_id = _request_project_id(session.get("current_project_id"))
    if not _session_project_is_authorized(project_id):
        return _project_not_found_response()

    if mode == 'demo':
        output_dir = get_demo_project_outputs_dir(project_id)
    else:
        output_dir = get_user_project_processed_dir(project_id)
    try:
        selected_file_exists = _selected_themes_file_exists(output_dir)
        display_only = request.args.get("displayOnly") == "1" or request.args.get("visualizationDisplay") == "1"
        if request.args.get("visualizationOnly") == "1":
            data = _visualization_theme_payload(
                mode=mode,
                project_id=project_id,
                require_applied_selection=request.args.get("requireApplied") == "1",
            )
        else:
            data = _load_selected_theme_payload(output_dir)
        if request.args.get("includeGeneratedQuotes") == "1":
            output_path = os.path.join(output_dir, "ai_generated.json")
            generated_payload = build_theme_object_from_output(
                output_path,
                prefer_selected=False,
            )
            include_generated_only = (
                request.args.get("includeGeneratedThemes") == "1"
                and not selected_file_exists
                and not display_only
            )
            data = _merge_theme_payloads_preserving_manual(
                _merge_generated_quotes_into_theme_payload(data, output_dir),
                generated_payload,
                include_generated_only=include_generated_only,
            )
        if display_only and request.args.get("includeUnselectedManual") != "1":
            data = _filter_theme_payload_for_visualization_display(data)
        data = _canonicalize_selected_theme_payload(data)
        if isinstance(data, dict):
            data["selectedThemesExists"] = selected_file_exists
            data["projectRevision"] = _project_revision(project_id)
        return jsonify(data if isinstance(data, dict) else {
            "themes": [],
            "selectedThemesExists": selected_file_exists,
        }), 200
    except Exception as e:
        return jsonify({"error": "Failed to load", "details": str(e)}), 500


@themes_bp.route('/api/has_selected_themes', methods=['GET'])
def has_selected_themes():
    if 'user_id' not in session:
        return jsonify({"exists": False}), 200
    ensure_user_session_context()

    mode = session.get('mode', 'user')
    project_id = _request_project_id(session.get("current_project_id"))
    if not _session_project_is_authorized(project_id):
        return jsonify({"exists": False}), 404
    if mode == 'demo':
        output_dir = get_demo_project_outputs_dir(project_id)
    else:
        output_dir = get_user_project_processed_dir(project_id)

    filepath = os.path.join(output_dir, 'SelectedThemes.json')
    return jsonify({"exists": os.path.exists(filepath)}), 200


@themes_bp.route('/api/load_ai_generated', methods=['GET'])
def load_ai_generated():
    ensure_user_session_context()
    mode = session.get('mode', 'user')
    project_id = _request_project_id(session.get("current_project_id"))
    if mode == 'demo':
        output_path = get_demo_output_json_path(project_id)
    else:
        output_path = get_user_output_json_path(project_id)
    if not os.path.exists(output_path):
        return jsonify({}), 200
    try:
        with open(output_path, 'r', encoding='utf-8') as f:
            return jsonify(json.load(f)), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@themes_bp.route('/api/generate_more_codes', methods=['POST'])
def api_generate_more_codes():
    ensure_user_session_context()

    request_payload = request.get_json(silent=True) or {}
    mode = session.get('mode', 'user')
    project_id = _request_project_id(session.get("current_project_id"), request_payload)

    try:
        requested_count = int(request_payload.get("count", 5))
    except (TypeError, ValueError):
        requested_count = 5
    requested_count = max(1, min(10, requested_count))

    runtime_dirs = _resolve_project_runtime_dirs(mode, project_id)
    processed_dir = runtime_dirs.get("processed_dir")
    if not processed_dir:
        return jsonify({"error": "Could not resolve project output directory."}), 400

    transcripts_path = os.path.join(processed_dir, "all_transcripts_processed.json")
    if not _json_file_has_content(transcripts_path):
        return jsonify({"error": "Process transcripts before generating more AI codes."}), 400

    output_path = _output_json_path_for_mode_project(mode=mode, project_id=project_id)
    output_dir = _selected_themes_output_dir(mode=mode, project_id=project_id)
    selected_payload = _load_selected_theme_payload(output_dir)
    _seed_ai_generated_output_from_theme_payload(output_path, selected_payload)
    selected_codes = [
        str(theme.get("themeName") or theme.get("theme") or theme.get("name") or "").strip()
        for theme in (selected_payload.get("themes", []) if isinstance(selected_payload, dict) else [])
        if isinstance(theme, dict) and str(theme.get("themeName") or theme.get("theme") or theme.get("name") or "").strip()
    ]
    existing_codes = request_payload.get("existingCodes")
    if isinstance(existing_codes, list):
        existing_codes = [*existing_codes, *selected_codes, *load_theme_titles_from_output_json(output_path)]
    else:
        existing_codes = [*selected_codes, *load_theme_titles_from_output_json(output_path)]
    existing_codes = list(dict.fromkeys(
        str(code or "").strip()
        for code in existing_codes
        if str(code or "").strip()
    ))

    try:
        qwen = _build_qwen_runtime(
            mode,
            project_id,
            processed_dir=processed_dir,
            intermediate_dir=runtime_dirs.get("intermediate_dir"),
        )
        qwen.extract_answers_by_tag()
        added_codes = qwen.generate_more_themes(existing_codes, count=requested_count)

        generated_payload = build_theme_object_from_output(output_path, prefer_selected=False)
        if _has_selected_theme_state(selected_payload):
            theme_object = _merge_theme_payloads_preserving_manual(
                _merge_generated_quotes_into_theme_payload(selected_payload, output_dir),
                generated_payload,
                include_generated_only=True,
            )
        else:
            theme_object = generated_payload
        theme_object = _mark_ai_generated_code_payload_applied(theme_object, source="ai_generate_more_codes")

        if _has_theme_payload(theme_object):
            _persist_selected_theme_payload(theme_object, mode=mode, project_id=project_id)

        all_codes = [
            str(theme.get("themeName") or theme.get("theme") or theme.get("name") or "").strip()
            for theme in (theme_object.get("themes", []) if isinstance(theme_object, dict) else [])
            if isinstance(theme, dict) and str(theme.get("themeName") or theme.get("theme") or theme.get("name") or "").strip()
        ]
        if all_codes:
            write_topics_qwen(all_codes, project_id=project_id, mode=mode)

        if _safe_project_id(project_id) == _safe_project_id(session.get("current_project_id")):
            _store_theme_object_in_session(theme_object, project_id)

        return jsonify({
            "message": "Generated additional AI code suggestions.",
            "addedCodes": added_codes,
            "codeCount": len(all_codes),
            "themeObject": theme_object,
        }), 200
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": "Could not generate more AI codes.", "details": str(e)}), 500
