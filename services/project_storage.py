"""Private project paths and file access rules, independent of Flask."""

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




def contained_file(root: str, relative_path: str) -> Path | None:
    """Reject traversal and symlinks that lead outside an authorized directory."""
    if not relative_path or "\\" in relative_path:
        return None
    relative = Path(relative_path)
    if relative.is_absolute() or ".." in relative.parts:
        return None
    authorized_root = Path(root).resolve()
    candidate = (authorized_root / relative).resolve()
    if authorized_root not in candidate.parents:
        return None
    if not candidate.is_file():
        return None
    return candidate


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
