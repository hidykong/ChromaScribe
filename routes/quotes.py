"""Quotes routes, using the current main behavior.

Independent helpers live in services; project/session workflows remain in app.py.
app.py registers these blueprints after defining their remaining dependencies.
"""

import json
import os

from flask import (
    Blueprint,
    jsonify,
    request,
    session,
)

from app import (
    _quote_archive_action_details,
    _request_project_id,
    ensure_user_session_context,
    get_demo_project_outputs_dir,
    get_user_project_processed_dir,
)

from services.storage import (
    _load_json_payload_if_exists,
)


quotes_bp = Blueprint("quotes", __name__)


@quotes_bp.route('/api/save_deleted_quotes', methods=['POST'])
def save_deleted_quotes():
    ensure_user_session_context()

    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "No data received"}), 400

    mode = session.get('mode', 'user')
    project_id = _request_project_id(session.get("current_project_id"), data if isinstance(data, dict) else None)
    if isinstance(data, dict):
        data = {
            key: value
            for key, value in data.items()
            if key not in {"projectId", "project_id"}
        }
    if mode == 'demo':
        output_dir = get_demo_project_outputs_dir(project_id)
    else:
        output_dir = get_user_project_processed_dir(project_id)

    filepath = os.path.join(output_dir, 'deletedQuotes.json')
    try:
        previous_payload = _load_json_payload_if_exists(filepath, {"deletedQuotes": []})
        os.makedirs(output_dir, exist_ok=True)
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        action_details = _quote_archive_action_details(previous_payload, data)
        operation = "update"
        if action_details["archivedQuoteCount"] > 0 and action_details["restoredQuoteCount"] == 0:
            operation = "delete"
        elif action_details["restoredQuoteCount"] > 0 and action_details["archivedQuoteCount"] == 0:
            operation = "restore"
        return jsonify({"message": "Saved successfully."}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@quotes_bp.route('/api/load_deleted_quotes', methods=['GET'])
def load_deleted_quotes():
    ensure_user_session_context()

    mode = session.get('mode', 'user')
    project_id = _request_project_id(session.get("current_project_id"))
    if mode == 'demo':
        output_dir = get_demo_project_outputs_dir(project_id)
    else:
        output_dir = get_user_project_processed_dir(project_id)

    filepath = os.path.join(output_dir, 'deletedQuotes.json')
    if not os.path.exists(filepath):
        return jsonify({"deletedQuotes": []}), 200
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return jsonify(data), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@quotes_bp.route('/api/clear_deleted_quotes', methods=['POST'])
def clear_deleted_quotes():
    ensure_user_session_context()

    mode = session.get('mode', 'user')
    project_id = _request_project_id(session.get("current_project_id"))
    if mode == 'demo':
        output_dir = get_demo_project_outputs_dir(project_id)
    else:
        output_dir = get_user_project_processed_dir(project_id)

    filepath = os.path.join(output_dir, 'deletedQuotes.json')
    try:
        previous_payload = _load_json_payload_if_exists(filepath, {"deletedQuotes": []})
        if os.path.exists(filepath):
            os.remove(filepath)
        return jsonify({"message": "Deleted quotes cleared."}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500
