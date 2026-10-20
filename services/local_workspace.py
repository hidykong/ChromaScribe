"""Session context for the single workspace in the local open-source edition."""

from ipaddress import ip_address
from urllib.parse import urlparse
from uuid import uuid4

LOCAL_WORKSPACE_KEY = "local"
LOCAL_HOSTNAMES = {"localhost", "127.0.0.1", "::1"}


def is_local_session(state) -> bool:
    return (
        state.get("user") == LOCAL_WORKSPACE_KEY
        and state.get("user_id") == LOCAL_WORKSPACE_KEY
        and state.get("user_workspace_key") == LOCAL_WORKSPACE_KEY
    )


def initialize_local_session(state) -> None:
    """Restore a stable workspace without retaining a previous account's projects."""
    if not is_local_session(state):
        state.clear()
    state.update({
        "user": LOCAL_WORKSPACE_KEY,
        "user_id": LOCAL_WORKSPACE_KEY,
        "user_key": LOCAL_WORKSPACE_KEY,
        "user_workspace_key": LOCAL_WORKSPACE_KEY,
        "user_index": 0,
    })
    state.setdefault("session_id", str(uuid4()))


def local_request_error(incoming_request) -> str | None:
    """Keep the login-free workspace on this computer and reject cross-site requests."""
    try:
        local_address = ip_address(incoming_request.remote_addr or "").is_loopback
    except ValueError:
        local_address = False
    hostname = urlparse(incoming_request.host_url).hostname
    if not local_address or hostname not in LOCAL_HOSTNAMES:
        return "This edition is available only on this computer. Open it through localhost or 127.0.0.1."
    # Some GET routes start processing jobs, so check their origin too.
    origin = incoming_request.headers.get("Origin")
    if origin and origin.rstrip("/") != incoming_request.host_url.rstrip("/"):
        return "Requests must come from this local ChromaScribe page."
    if incoming_request.headers.get("Sec-Fetch-Site") == "cross-site":
        return "Requests must come from this local ChromaScribe page."
    return None
