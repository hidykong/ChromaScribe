"""Questions routes, using the current main behavior.

Independent helpers live in services; project/session workflows remain in app.py.
app.py registers these blueprints after defining their remaining dependencies.
"""

import json
import os
import uuid

from flask import (
    Blueprint,
    has_request_context,
    jsonify,
    request,
    session,
)
from werkzeug.utils import secure_filename

from processing_scripts.question_import import import_question_file

from app import (
    ensure_demo_assets,
    ensure_user_session_context,
    get_demo_project_outputs_dir,
    get_demo_questions_json_path,
    get_questions_text_dir_for_mode,
    get_user_project_processed_dir,
    get_user_questions_json_path,
    sync_demo_project_to_active_assets,
)

from services.analytics import (
    _analysis_action_text_fingerprint,
)


questions_bp = Blueprint("questions", __name__)


def _question_storage_paths_for_mode(mode: str | None = None):
    resolved_mode = mode or (session.get('mode', 'user') if has_request_context() else 'user')
    project_id = session.get("current_project_id") if has_request_context() else None
    if resolved_mode == 'demo':
        questions_json_path = get_demo_questions_json_path(project_id)
    else:
        questions_json_path = get_user_questions_json_path(project_id)
    questions_text_path = os.path.join(
        get_questions_text_dir_for_mode(mode=resolved_mode, project_id=project_id),
        "questions.txt",
    )
    return questions_json_path, questions_text_path


def _load_question_list_from_path(questions_json_path: str) -> list[str]:
    if not questions_json_path or not os.path.exists(questions_json_path):
        return []
    try:
        with open(questions_json_path, 'r', encoding='utf-8') as f:
            payload = json.load(f)
        raw_questions = payload.get("questions", []) if isinstance(payload, dict) else []
        if not isinstance(raw_questions, list):
            return []
        return [str(question).strip() for question in raw_questions if str(question).strip()]
    except Exception as e:
        print(f"[WARN] Could not read questions from {questions_json_path}: {e}")
        return []


def _write_question_list_for_mode(questions_list: list[str], mode: str | None = None):
    resolved_mode = mode or (session.get('mode', 'user') if has_request_context() else 'user')
    questions_json_path, questions_text_path = _question_storage_paths_for_mode(resolved_mode)
    normalized_questions = [str(question).strip() for question in questions_list if str(question).strip()]

    os.makedirs(os.path.dirname(questions_json_path), exist_ok=True)
    with open(questions_json_path, 'w', encoding='utf-8') as f:
        json.dump({"questions": normalized_questions}, f, indent=2)

    os.makedirs(os.path.dirname(questions_text_path), exist_ok=True)
    with open(questions_text_path, "w", encoding="utf-8") as txt_out:
        txt_out.write("\n".join(normalized_questions))

    if resolved_mode == 'demo':
        sync_demo_project_to_active_assets(session.get("current_project_id"))

    return normalized_questions


def _delete_question_storage_for_mode(mode: str | None = None):
    resolved_mode = mode or (session.get('mode', 'user') if has_request_context() else 'user')
    questions_json_path, questions_text_path = _question_storage_paths_for_mode(resolved_mode)
    removed_paths = []
    for path in (questions_json_path, questions_text_path):
        if path and os.path.exists(path):
            os.remove(path)
            removed_paths.append(path)
    if resolved_mode == 'demo':
        sync_demo_project_to_active_assets(session.get("current_project_id"))
    return removed_paths


@questions_bp.route('/upload_question_set', methods=['POST'])
def upload_question_set_route():
    ensure_user_session_context()

    if 'question_file' not in request.files:
        return jsonify({"error": "No question_file part in request"}), 400

    file = request.files['question_file']
    original_filename = file.filename or ""

    if original_filename == '':
        return jsonify({"error": "No question file selected"}), 400

    mode = session.get('mode', 'user')
    if mode == 'demo':
        output_dir = get_demo_project_outputs_dir(session.get("current_project_id"))
        output_filename = "questions.json"
    else:
        output_dir = get_user_project_processed_dir()
        output_filename = "questions.json"

    output_filepath = os.path.join(output_dir, output_filename)
    try:
        original_content = file.read()
        imported = import_question_file(original_content, original_filename)

        # Keep the original separately from the normalized questions.txt that
        # the tagger reads. Failed parsing never replaces a saved guide.
        original_directory = os.path.join(
            get_questions_text_dir_for_mode(mode=mode, project_id=session.get("current_project_id")),
            "originals",
        )
        os.makedirs(original_directory, exist_ok=True)
        safe_filename = secure_filename(original_filename) or f"question-guide.{imported.format}"
        original_path = os.path.join(original_directory, f"{uuid.uuid4().hex}_{safe_filename}")
        with open(original_path, "wb") as original_file:
            original_file.write(original_content)

        questions_list = _write_question_list_for_mode(imported.questions, mode)

        print(f"Saved processed question set JSON to: {output_filepath}")

        return jsonify({
            "message": "Question set processed and saved as JSON.",
            "processedFilenameOnServer": output_filename,
            "questions": questions_list,
            "importSummary": imported.summary(),
        }), 200

    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except Exception as e:
        return jsonify({"error": "Server error during question file processing", "details": str(e)}), 500


@questions_bp.route('/api/save_manual_questions', methods=['POST'])
def save_manual_questions():
    ensure_user_session_context()

    questions_list = request.get_json()
    if not isinstance(questions_list, list) or len(questions_list) < 2:
        return jsonify({"error": "Invalid data format or not enough questions."}), 400

    mode = session.get('mode', 'user')

    if mode == 'demo':
        output_dir = get_demo_project_outputs_dir(session.get("current_project_id"))
    else:
        output_dir = get_user_project_processed_dir()

    output_filepath = os.path.join(output_dir, 'questions.json')
    os.makedirs(output_dir, exist_ok=True)

    try:
        previous_questions = _load_question_list_from_path(output_filepath)
        questions_list = _write_question_list_for_mode(questions_list, mode)

        before_set = set(previous_questions)
        after_set = set(questions_list)
        print(f"Manually entered questions saved to: {output_filepath}")
        return jsonify({"message": "Questions saved successfully.", "questions": questions_list}), 200
    except Exception as e:
        print(f"Error saving manual questions: {e}")
        return jsonify({"error": "Server error while saving questions"}), 500


@questions_bp.route('/api/delete_question', methods=['POST'])
def delete_question():
    ensure_user_session_context()

    payload = request.get_json(silent=True) or {}
    try:
        question_index = int(payload.get("index"))
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid question index."}), 400

    if question_index < 0:
        return jsonify({"error": "Invalid question index."}), 400

    mode = session.get('mode', 'user')
    remaining_questions = payload.get("questions")
    if isinstance(remaining_questions, list):
        questions_path, _ = _question_storage_paths_for_mode(mode)
        previous_questions = _load_question_list_from_path(questions_path)
        questions = _write_question_list_for_mode(remaining_questions, mode)
        deleted_question = previous_questions[question_index] if question_index < len(previous_questions) else ""
        return jsonify({
            "message": "Question deleted successfully.",
            "questions": questions,
        }), 200

    questions_path, _ = _question_storage_paths_for_mode(mode)
    questions = _load_question_list_from_path(questions_path)
    if not os.path.exists(questions_path):
        return jsonify({"error": "No saved question set found.", "questions": []}), 404
    if question_index >= len(questions):
        return jsonify({"error": "Question index is out of range.", "questions": questions}), 400

    deleted_question = questions.pop(question_index)
    questions = _write_question_list_for_mode(questions, mode)
    return jsonify({
        "message": "Question deleted successfully.",
        "deletedQuestion": deleted_question,
        "questions": questions,
    }), 200


@questions_bp.route('/api/delete_question_set', methods=['POST'])
def delete_question_set():
    ensure_user_session_context()

    mode = session.get('mode', 'user')
    questions_path, _ = _question_storage_paths_for_mode(mode)
    previous_questions = _load_question_list_from_path(questions_path)
    removed_paths = _delete_question_storage_for_mode(mode)
    return jsonify({
        "message": "Question set deleted successfully.",
        "removed": len(removed_paths),
        "questions": [],
    }), 200


@questions_bp.route('/api/check_questions_exist', methods=['GET'])
def check_questions_exist():
    ensure_user_session_context()

    mode = session.get('mode', 'user')

    questions_path, _ = _question_storage_paths_for_mode(mode)
    questions = _load_question_list_from_path(questions_path)
    return jsonify({
        "exists": len(questions) >= 2,
        "count": len(questions),
    }), 200


@questions_bp.route('/api/get_question_list', methods=['GET'])
def get_question_list():
    ensure_user_session_context()

    mode = session.get('mode', 'user')

    if mode == 'demo':
        ensure_demo_assets()
    questions_json_path, _ = _question_storage_paths_for_mode(mode)

    try:
        if os.path.exists(questions_json_path):
            questions = _load_question_list_from_path(questions_json_path)
            print(f"Found {len(questions)} questions in '{os.path.basename(questions_json_path)}' for {mode} mode.")
            return jsonify({"questions": questions}), 200
        print(f"Question list file not found at {questions_json_path}. Returning empty list.")
        return jsonify({"questions": []}), 200

    except Exception as e:
        print(f"Error reading question JSON file '{questions_json_path}': {e}")
        return jsonify({"error": "Could not read question file on server"}), 500


@questions_bp.route('/api/add_new_question', methods=['POST'])
def add_new_question():
    ensure_user_session_context()

    data = request.get_json()
    new_question_text = data.get('question_text')

    if not new_question_text or not isinstance(new_question_text, str):
        return jsonify({"error": "Invalid question text provided."}), 400

    mode = session.get('mode', 'user')

    questions_path, _ = _question_storage_paths_for_mode(mode)

    try:
        questions = _load_question_list_from_path(questions_path)
        questions.append(new_question_text.strip())
        questions = _write_question_list_for_mode(questions, mode)

        print(f"Added new question to '{questions_path}'.")
        return jsonify({"message": "Question added successfully.", "questions": questions}), 200

    except Exception as e:
        print(f"Error adding new question: {e}")
        return jsonify({"error": "Server error while adding question"}), 500
