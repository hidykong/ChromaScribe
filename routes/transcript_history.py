"""Undo Transcript edits without changing unrelated codes or transcript text."""

import copy
import os
from datetime import datetime, timezone

from flask import Blueprint, jsonify, make_response, request, session

from app import (
    _advance_project_revision,
    _atomic_write_json,
    _find_qna_cue_for_update,
    _load_json_payload_if_exists,
    _manual_code_selection_key,
    _normalize_theme_lookup_name,
    _output_json_path_for_mode_project,
    _project_mutation_lock,
    _qna_request_context,
    _refresh_qna_tag_conflicts_for_path,
    _selected_themes_output_dir,
    _store_theme_object_in_session,
    _tag_conflicts_path_for_mode,
    _theme_object_for_transcript_mode,
    ensure_user_session_context,
    get_demo_processed_transcripts_path,
    get_user_processed_transcripts_path,
)
from services.transcript_undo import (
    qna_state, read_history_record, restore_qna_state, sign_history_record,
)

transcript_history_bp = Blueprint("transcript_history", __name__)


def _matches_code(name, target):
    return _normalize_theme_lookup_name(name) == _normalize_theme_lookup_name(target)


def _code_opt_outs(payload, theme_name):
    code_key = _manual_code_selection_key(theme_name)
    opt_outs = payload.get("manualSelectionOptOuts") or {}
    return {
        "codes": [key for key in opt_outs.get("codes", []) if key == code_key],
        "excerpts": [key for key in opt_outs.get("excerpts", []) if key.startswith(code_key + "::")],
    }


def _read_code_files(mode, project_id):
    selected_path = os.path.join(_selected_themes_output_dir(mode, project_id), "SelectedThemes.json")
    generated_path = _output_json_path_for_mode_project(mode=mode, project_id=project_id)
    selected = _load_json_payload_if_exists(selected_path, {"themes": []})
    generated = _load_json_payload_if_exists(generated_path, {})
    return selected_path, generated_path, selected, generated


def _code_state(selected, generated, theme_name):
    return copy.deepcopy({
        "selected": [theme for theme in selected.get("themes", [])
                     if _matches_code(theme.get("themeName"), theme_name)],
        "generated": {name: value for name, value in generated.items()
                      if _matches_code(name, theme_name)},
        "optOuts": _code_opt_outs(selected, theme_name),
    })


def _restore_code_files(files, theme_name, previous):
    selected_path, generated_path, selected, generated = files
    original_selected = copy.deepcopy(selected)
    current_themes = selected.get("themes", [])
    position = len(current_themes)
    for index, theme in enumerate(current_themes):
        if _matches_code(theme.get("themeName"), theme_name):
            position = index
            break
    other_themes = [theme for theme in selected.get("themes", [])
                    if not _matches_code(theme.get("themeName"), theme_name)]
    selected["themes"] = other_themes[:position] + previous["selected"] + other_themes[position:]
    opt_outs = selected.setdefault("manualSelectionOptOuts", {"codes": [], "excerpts": []})
    current_opt_outs = _code_opt_outs(selected, theme_name)
    for category in ("codes", "excerpts"):
        other_keys = [key for key in opt_outs.get(category, []) if key not in current_opt_outs[category]]
        opt_outs[category] = other_keys + previous["optOuts"][category]
    other_generated = {name: value for name, value in generated.items()
                       if not _matches_code(name, theme_name)}
    other_generated.update(previous["generated"])
    selected["updatedAt"] = datetime.now(timezone.utc).isoformat()
    _atomic_write_json(selected_path, selected)
    try:
        _atomic_write_json(generated_path, other_generated)
    except OSError:
        _atomic_write_json(selected_path, original_selected)
        raise


@transcript_history_bp.route("/api/transcript_code_history", methods=["POST"])
def transcript_code_history():
    ensure_user_session_context()
    payload = request.get_json(silent=True) or {}
    mode, project_id = _qna_request_context(payload)
    action = payload.get("action")
    theme_name = str(payload.get("themeName") or "").strip()
    if action not in {"capture", "record"} or not theme_name:
        return jsonify({"error": "Missing code or history action."}), 400

    try:
        with _project_mutation_lock(project_id):
            _, _, selected_payload, generated_payload = _read_code_files(mode, project_id)
            current = _code_state(selected_payload, generated_payload, theme_name)
            if action == "capture":
                token = sign_history_record("code_checkpoint", theme_name, current, None, mode, project_id)
                return jsonify({"checkpoint": token})
            record = read_history_record(payload.get("checkpoint"), mode, project_id)
            if record["kind"] != "code_checkpoint" or record["target"] != theme_name:
                raise ValueError("The undo checkpoint does not match this code.")
            if record["before"] == current:
                return jsonify({"undoToken": None})
            token = sign_history_record("code", theme_name, record["before"], current, mode, project_id)
            return jsonify({"undoToken": token})
    except ValueError as error:
        return jsonify({"error": str(error)}), 400


def _undo_qna(record, mode, project_id):
    path = get_demo_processed_transcripts_path(project_id) if mode == "demo" else get_user_processed_transcripts_path(project_id)
    transcripts = _load_json_payload_if_exists(path, {})
    target = record["target"]
    _, _, cue = _find_qna_cue_for_update(
        transcripts, target.get("fileKey") or target.get("key"),
        target.get("timestamp"), target.get("participant"), target.get("segmentId"),
    )
    if cue is None or qna_state(cue) != record["after"]:
        return jsonify({"error": "This tag has changed since your edit. Reload before undoing it."}), 409
    restore_qna_state(cue, record["before"])
    _atomic_write_json(path, transcripts)
    conflicts = _refresh_qna_tag_conflicts_for_path(path, _tag_conflicts_path_for_mode(mode, project_id))
    return jsonify({"cue": cue, "tagConflicts": conflicts})


def _undo_code(record, mode, project_id):
    files = _read_code_files(mode, project_id)
    _, _, selected_payload, generated_payload = files
    if _code_state(selected_payload, generated_payload, record["target"]) != record["after"]:
        return jsonify({"error": "This code has changed since your edit. Reload before undoing it."}), 409
    _restore_code_files(files, record["target"], record["before"])
    revision = _advance_project_revision(project_id)
    # An empty codebook is intentional after undoing its first code. Clear the
    # session copy before loading the editor's fallback data.
    _store_theme_object_in_session(selected_payload, project_id)
    payload = _theme_object_for_transcript_mode(mode, project_id)
    payload["projectRevision"] = revision
    _store_theme_object_in_session(payload, project_id)
    return jsonify({"themes": payload})


@transcript_history_bp.route("/api/undo_transcript_edit", methods=["POST"])
def undo_transcript_edit():
    ensure_user_session_context()
    payload = request.get_json(silent=True) or {}
    mode, project_id = _qna_request_context(payload)
    try:
        record = read_history_record(payload.get("undoToken"), mode, project_id)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    with _project_mutation_lock(project_id):
        if record["kind"] == "qna":
            result = _undo_qna(record, mode, project_id)
        elif record["kind"] == "code":
            result = _undo_code(record, mode, project_id)
        else:
            return jsonify({"error": "This record cannot be undone."}), 400
    response = make_response(result)
    return response
