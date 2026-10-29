"""Private project paths and file access rules, independent of Flask."""

import os
import re
from pathlib import Path

PRIVATE_STATIC_DIRECTORIES = frozenset({
    "User_projects",
    "Uploaded_files",
    "Processed_files",
    "Demo_project",
    "audio_storage",
})


def user_projects_root(storage_root: str, create: bool = True) -> str:
    root = Path(storage_root) / "User_projects"
    if create:
        root.mkdir(parents=True, exist_ok=True)
    return str(root)


def workspace_root(storage_root: str, workspace_key: str, create: bool = True) -> str:
    if not re.fullmatch(r"[\w-]+", workspace_key or ""):
        raise ValueError("Invalid workspace key.")
    projects_root = Path(user_projects_root(storage_root, create=create))
    root = projects_root / "users" / workspace_key
    if create:
        root.mkdir(parents=True, exist_ok=True)
    return str(root)


def is_safe_relative_path(relative_path: str) -> bool:
    """Accept browser folder paths, rejecting absolute paths on every platform."""
    if not isinstance(relative_path, str) or not relative_path:
        return False
    # Backslashes, drive letters and alternate data streams are Windows paths too.
    if any(character in relative_path for character in ("\\", ":", "\x00")):
        return False
    if relative_path.startswith("/"):
        return False
    return not any(part in {".", ".."} for part in relative_path.split("/"))


def contained_path(root: str, relative_path: str) -> Path | None:
    """Resolve existing or new files without following a link outside the root."""
    if not is_safe_relative_path(relative_path):
        return None
    try:
        authorized_root = Path(root).resolve()
        candidate = authorized_root / relative_path
        resolved = candidate.resolve()
    except (OSError, RuntimeError, ValueError):
        return None
    if authorized_root not in resolved.parents:
        return None
    return candidate


def contained_file(root: str, relative_path: str) -> Path | None:
    """Return an existing file only when it stays inside its authorized directory."""
    candidate = contained_path(root, relative_path)
    if candidate is None or not candidate.is_file():
        return None
    return candidate.resolve()


def find_contained_file(base_dirs: list[str], relative_paths: list[str], basename: str) -> str | None:
    """Keep legacy filename fallback without letting symlinks escape storage."""
    for base_dir in base_dirs:
        for relative_path in relative_paths:
            candidate = contained_file(base_dir, relative_path)
            if candidate is not None:
                return str(candidate)

    for base_dir in base_dirs:
        for directory, _, filenames in os.walk(base_dir):
            if basename not in filenames:
                continue
            relative_path = os.path.relpath(os.path.join(directory, basename), base_dir)
            candidate = contained_file(base_dir, relative_path.replace(os.sep, "/"))
            if candidate is not None:
                return str(candidate)
    return None


def authorized_workspace_file(
    storage_root: str,
    relative_path: str,
    workspace_key: str,
) -> Path | None:
    """Resolve a legacy User_projects URL only inside the caller's workspace."""
    if not re.fullmatch(r"[\w-]+", workspace_key or ""):
        return None
    parts = relative_path.split("/")
    if len(parts) < 3 or parts[:2] != ["users", workspace_key]:
        return None
    authorized_root = workspace_root(storage_root, workspace_key, create=False)
    path_within_workspace = "/".join(parts[2:])
    return contained_file(authorized_root, path_within_workspace)
