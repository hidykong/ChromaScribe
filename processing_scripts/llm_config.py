import os
import re
from urllib.parse import urlparse

# Fallbacks when nothing is configured
DEFAULT_BASE_URL = "http://localhost:11434/v1"
DEFAULT_MODEL = "qwen3:latest"

# Provider selection controls request formatting and whether an API key is required.
_KNOWN_PROVIDERS = (
    ("groq.com", "groq"),
    ("generativelanguage.googleapis.com", "google"),
    ("api.openai.com", "openai"),
    ("openrouter.ai", "openrouter"),
    ("api.together.xyz", "together"),
    ("api.mistral.ai", "mistral"),
    ("api.deepseek.com", "deepseek"),
    ("api.x.ai", "xai"),
    ("gccis.rit.edu", "rit"),
    (":11434", "ollama"),
    (":1234", "lmstudio"),
)
_LOCAL_PROVIDERS = {"ollama", "lmstudio", "local"}


def _env(*names):
    """Return the first non-empty env var among names (quotes/spaces stripped)."""
    for name in names:
        value = os.environ.get(name)
        if value is not None:
            value = value.strip().strip('"').strip("'").strip()
            if value:
                return value
    return ""


def normalize_base_url(url):
    """Keep the provider's own path (/v1, /v1beta/openai, ...) but drop
    accidental endpoint suffixes like /models or /chat/completions."""
    url = str(url or "").strip().rstrip("/")
    url = re.sub(r"/(chat/completions|completions|models)$", "", url, flags=re.IGNORECASE)
    return url


def detect_provider(base_url):
    lowered = base_url.lower()
    for needle, name in _KNOWN_PROVIDERS:
        if needle in lowered:
            return name
    host = (urlparse(base_url).hostname or "").lower()
    if host in {"localhost", "127.0.0.1", "0.0.0.0"}:
        return "local"
    return host or "custom"


def provider_needs_api_key(provider):
    return provider not in _LOCAL_PROVIDERS


def resolve_llm_config():
    """
    Returns (provider, base_url, model, api_key).
    Reads generic LLM_* variables first, then legacy RIT_GENAI_* variables.
    """
    base_url = normalize_base_url(_env("LLM_BASE_URL", "RIT_GENAI_BASE_URL") or DEFAULT_BASE_URL)
    model = _env("LLM_MODEL", "RIT_GENAI_MODEL") or DEFAULT_MODEL
    provider = (_env("LLM_PROVIDER") or detect_provider(base_url)).lower()
    if (urlparse(base_url).hostname or "").lower() == "api.groq.com":
        # A stale provider override must not disable Groq's structured output.
        provider = "groq"
    api_key = _env("LLM_API_KEY", "RIT_GENAI_API_KEY")
    if not api_key:
        api_key = "not-needed" if not provider_needs_api_key(provider) else "missing"
    return provider, base_url, model, api_key


def llm_endpoint_ready(client):
    """
    Check the endpoint without assuming every provider supports /models.
    Returns (ok, error).
    """
    try:
        client.models.list()
        return True, None
    except Exception as exc:
        status = getattr(exc, "status_code", None)
        if status in (401, 403):
            return False, exc          # bad key / no access
        if status in (404, 405, 501):
            return True, None          # provider just doesn't expose /models
        return False, exc              # connection errors etc.