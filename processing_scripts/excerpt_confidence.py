"""Keep model self-ratings separate from transcript source matching."""

import math


def normalize_model_score(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or not 0 <= value <= 1:
        return None
    return float(value)


def read_model_confidence(quote):
    if not isinstance(quote, dict) or quote.get("confidenceSource") != "model_self_reported":
        return None
    return normalize_model_score(quote.get("confidence"))
