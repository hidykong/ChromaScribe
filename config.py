"""Deployment settings. Importing this module does not connect to any service."""

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parent


def load_local_environment() -> None:
    """Tests and clean-clone checks can explicitly disable the local .env file."""
    load_dotenv_setting = os.environ.get("CHROMASCRIBE_LOAD_DOTENV", "1").lower()
    if load_dotenv_setting not in {"0", "false", "no"}:
        load_dotenv(REPO_ROOT / ".env", override=False)


def environment_flag(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes"}


def configured_path(value: str, default: Path) -> Path:
    if value:
        path = Path(value).expanduser()
    else:
        path = default

    if not path.is_absolute():
        path = REPO_ROOT / path
    return path.resolve()


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    public_base_url: str
    secret_key: str
    port: int
    debug: bool


def load_settings() -> Settings:
    load_local_environment()
    data_dir = configured_path(
        os.environ.get("CHROMASCRIBE_DATA_DIR", ""),
        REPO_ROOT / ".private" / "runtime",
    )
    public_static = (REPO_ROOT / "static").resolve()
    overlaps_public_storage = (
        data_dir == public_static
        or public_static in data_dir.parents
        or data_dir in public_static.parents
    )
    if overlaps_public_storage:
        raise ValueError("CHROMASCRIBE_DATA_DIR must be outside the public static directory.")

    public_base_url = os.environ.get(
        "CHROMASCRIBE_PUBLIC_BASE_URL",
        "http://127.0.0.1:5001",
    ).rstrip("/")
    secret_key = os.environ.get("CHROMASCRIBE_SECRET_KEY") or os.environ.get("SECRET_KEY") or ""

    return Settings(
        data_dir=data_dir,
        public_base_url=public_base_url,
        secret_key=secret_key,
        port=int(os.environ.get("CHROMASCRIBE_PORT", "5001")),
        debug=environment_flag("CHROMASCRIBE_DEBUG"),
    )


settings = load_settings()
