"""Structured code-generation responses for Groq's supported GPT-OSS models."""

from copy import deepcopy


QUOTE_PROPERTIES = {
    "speaker": {"type": "string"},
    "text": {"type": "string"},
    "confidence": {"type": "number"},
}
QUOTE_SCHEMA = {
    "type": "object",
    "properties": QUOTE_PROPERTIES,
    "required": list(QUOTE_PROPERTIES),
    "additionalProperties": False,
}

THEME_PROPERTIES = {
    "title": {"type": "string"},
    "summary": {"type": "string"},
    "quotes": {"type": "array", "items": QUOTE_SCHEMA},
}
THEME_SCHEMA = {
    "type": "object",
    "properties": THEME_PROPERTIES,
    "required": list(THEME_PROPERTIES),
    "additionalProperties": False,
}

THEME_GENERATION_SCHEMA = {
    "type": "object",
    "properties": {"themes": {"type": "array", "items": THEME_SCHEMA}},
    "required": ["themes"],
    "additionalProperties": False,
}
GROQ_STRUCTURED_THEME_MODELS = {"openai/gpt-oss-20b", "openai/gpt-oss-120b"}


def theme_generation_response_format(provider, model):
    """Leave other providers and models on their existing request format."""
    if str(provider or "").strip().lower() != "groq":
        return None
    if str(model or "").strip().lower() not in GROQ_STRUCTURED_THEME_MODELS:
        return None
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "theme_generation",
            "strict": True,
            "schema": deepcopy(THEME_GENERATION_SCHEMA),
        },
    }
