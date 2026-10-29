import os
from flask import Blueprint, send_from_directory

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))

llm_setup_bp = Blueprint("llm_setup", __name__)


@llm_setup_bp.route("/llm-setup")
def llm_setup_guide():
    return send_from_directory(PROJECT_ROOT, "README-LLM-key-setup.html")

