import os
from flask import Blueprint, send_from_directory, jsonify
from processing_scripts.llm_config import resolve_llm_config

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))

llm_setup_bp = Blueprint("llm_setup", __name__)


@llm_setup_bp.route("/llm-setup")
def llm_setup_guide():
    return send_from_directory(PROJECT_ROOT, "README-LLM-key-setup.html")

@llm_setup_bp.route("/api/llm-config")
def llm_config():
    provider, _base_url, model, _api_key = resolve_llm_config()
    return jsonify({"provider": provider, "model": model})