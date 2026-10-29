"""Demographics routes, using the current main behavior.

Shared storage, session, and analysis helpers remain in app.py.
app.py registers these blueprints after defining those helpers.
"""

import json
import os

from flask import (
    Blueprint,
    jsonify,
    redirect,
    render_template,
    request,
    session,
    url_for,
)

from app import (
    DEMOGRAPHICS_JSON_DIR,
    DEMO_DEMOGRAPHICS_PATH,
    _mark_project_workflow_step,
    _request_project_id,
    demo_prefixed_path,
    get_demo_demographics_path,
    get_user_demographics_path,
    is_demo_prefixed_path,
)


demographics_bp = Blueprint("demographics", __name__)


def _default_demo_object():
    """Return fresh fields so one request cannot mutate another's defaults."""
    return {
        "options": [
            {"field": "age", "type": "Integer", "values": []},
            {"field": "gender", "type": "Text", "values": []},
            {"field": "educationLevel", "type": "Text", "values": []},
            {"field": "ethnicity", "type": "Text", "values": []},
            {"field": "maritalStatus", "type": "Text", "values": []},
            {"field": "location", "type": "Text", "values": []},
            {"field": "occupation", "type": "Text", "values": []},
        ],
        "chosenFields": [],
        "transcripts": [],
    }


@demographics_bp.route('/demographics', methods=['GET', 'POST'])
def demographics():
    target = url_for("demographics.demographics_choose_attr")
    if is_demo_prefixed_path(request.path):
        target = demo_prefixed_path(target)
    return redirect(target)


@demographics_bp.route('/demographics/choose-attributes', methods=['GET', 'POST'])
def demographics_choose_attr():
    if request.method == 'POST':
        demographics_object = request.json
        session['demographicsObject'] = demographics_object
        return '', 204

    default_demo_object = _default_demo_object()
    demographics_object = session.get('demographicsObject') or default_demo_object
    return render_template(
        'demographics-page/choose-attributes.html',
        demographicsObject=demographics_object,
    )


@demographics_bp.route('/demographics/edit-attributes', methods=['GET', 'POST'])
def demographics_edit_attr():
    if request.method == 'POST':
        demographics_object = request.json
        session['demographicsObject'] = demographics_object
        return '', 204
    default_demo_object = _default_demo_object()
    demographics_object = session.get('demographicsObject') or default_demo_object
    return render_template(
        'demographics-page/edit-attributes.html',
        demographicsObject=demographics_object,
    )


@demographics_bp.route('/demographics/demographics-manager', methods=['GET', 'POST'])
def demographics_manage_transcripts_route():
    # This route serves the HTML page for the manager.
    # The demographicsObject here defines *which columns* appear in the grid.
    mode = session.get('mode', 'user')

    if request.method == 'POST':
        demographics_object = request.json
        session['demographicsObject'] = demographics_object
        return '', 204
    # For GET request (when window.location.href navigates here)
    default_demo_object = _default_demo_object()
    demographics_object = session.get('demographicsObject', default_demo_object)
    return render_template(
        'demographics-page/demographics-manager.html',
        demographicsObject=demographics_object,
        mode=mode,
    )


@demographics_bp.route('/save_demographics_data', methods=['POST'])
def save_demographics_data():

    data_to_save = request.get_json() # Expects {"P1": {"age": 30, ...}, "P2": ...}
    if not data_to_save:
        return jsonify({'status': 'error', 'message': 'No data received for demographics'}), 400

    mode = session.get('mode', 'user')
    filepath = ""
    success_message = ""

    if mode == 'demo':
        filepath = get_demo_demographics_path(session.get("current_project_id"))
        print(f"DEMO MODE: Saving demographics to hidden workspace file: {filepath}")
        success_message = "Demo demographic data saved successfully!"
    else:
        project_id = _request_project_id(session.get("current_project_id"))
        filepath = get_user_demographics_path(project_id)
        success_message = "Demographics saved for this project."

    try:
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data_to_save, f, indent=2)
        if mode != "demo":
            _mark_project_workflow_step(
                _request_project_id(session.get("current_project_id")),
                "demographics_saved",
                {
                    "recordCount": len(data_to_save) if isinstance(data_to_save, dict) else 0,
                    "artifact": "demographics/DEMOGRAPHICS.json",
                },
            )

        print(f"Demographics data saved to: {filepath}")
        return jsonify({'status': 'success', 'message': success_message}), 200
    except Exception as e:
        print(f"Error saving demographics JSON: {e}")
        return jsonify({'status': 'error', 'message': 'Failed to save demographics data on server', 'details': str(e)}), 500


@demographics_bp.route('/load_demographics_data/<filename>', methods=['GET'])
def load_demographics_data(filename):
    # Add security: ensure filename is safe and user is authorized

    if ".." in filename or filename.startswith(("/", "\\")):
        return jsonify({"error": "Invalid filename"}), 400

    mode = session.get('mode', 'user')
    if mode == 'demo':
        filepath = get_demo_demographics_path(session.get("current_project_id"))
        if not os.path.exists(filepath):
            filepath = DEMO_DEMOGRAPHICS_PATH
    else:
        project_path = get_user_demographics_path(session.get("current_project_id"))
        filepath = project_path

    if os.path.exists(filepath):
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                data = json.load(f)
            return jsonify(data), 200
        except Exception as e:
            return jsonify({"error": "Failed to load demographics data", "details": str(e)}), 500
    else:
        return jsonify({"error": "Demographics file not found"}), 404


@demographics_bp.route('/api/get_latest_demographics_file', methods=['GET'])
def get_latest_demographics_file():

    try:
        mode = session.get('mode', 'user')
        if mode != "demo":
            project_path = get_user_demographics_path(session.get("current_project_id"))
            if os.path.exists(project_path):
                print(f"Found demographics file for project: {project_path}")
                return jsonify({"latest_filename": "DEMOGRAPHICS.json"}), 200
            print(f"No demographics file found for project: {project_path}")
            return jsonify({"error": "No demographic data files found for this project."}), 404

        files = [f for f in os.listdir(DEMOGRAPHICS_JSON_DIR) if f.endswith('.json')]
        print(f"Found demographic files in {DEMOGRAPHICS_JSON_DIR}: {files}")
        if not files:
            return jsonify({"error": "No demographic data files found."}), 404

        # Find the most recently modified file
        latest_file = max(files, key=lambda f: os.path.getmtime(os.path.join(DEMOGRAPHICS_JSON_DIR, f)))

        print(f"Found latest demographics file: {latest_file}")
        return jsonify({"latest_filename": latest_file}), 200

    except Exception as e:
        print(f"Error finding latest demographics file: {e}")
        return jsonify({"error": "Server error while searching for file", "details": str(e)}), 500
