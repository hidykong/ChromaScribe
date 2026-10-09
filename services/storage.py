"""File helpers with explicit paths; no Flask or application imports."""

import hashlib
import json
import os
import uuid


def _atomic_write_json(path: str, payload) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp_path = f"{path}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


def _file_sha1(filepath: str) -> str:
    digest = hashlib.sha1()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _project_relative_storage_path(path: str | None, project_root: str | None) -> str:
    if not path or not project_root:
        return ""
    try:
        return os.path.relpath(path, project_root).replace("\\", "/")
    except Exception:
        return os.path.basename(path)


def _json_file_has_content(path: str) -> bool:
    if not path or not os.path.exists(path):
        return False
    try:
        if os.path.getsize(path) <= 2:
            return False
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return len(data) > 0
        if isinstance(data, list):
            return len(data) > 0
        return bool(data)
    except Exception:
        return False


def _load_json_or_none(path: str):
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _read_json_if_exists(path: str):
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"[WARN] Failed to read JSON at {path}: {e}")
        return None


def _load_json_payload_if_exists(filepath: str | None, default=None):
    if not filepath or not os.path.exists(filepath):
        return default
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"[WARN] Could not load JSON payload for action diff {filepath}: {e}")
        return default
