"""Analytics calculations over supplied payloads, independent of Firebase."""

import hashlib
import re


def _safe_usage_log_key(value: str | None, default: str = "unknown") -> str:
    raw = str(value or "").strip()
    safe = re.sub(r"[^a-zA-Z0-9_-]+", "_", raw).strip("_")
    return safe or default


def _usage_log_increment(bucket: dict, key: str, amount: int | float | None):
    safe_amount = max(0, int(amount or 0))
    bucket[key] = max(0, int(bucket.get(key, 0) or 0) + safe_amount)


def _usage_log_child(parent: dict, key: str) -> dict:
    existing = parent.get(key)
    if not isinstance(existing, dict):
        existing = {}
        parent[key] = existing
    return existing


def _usage_metrics_readable(metrics: dict) -> dict:
    readable = {}
    for metric_name, raw_value in (metrics or {}).items():
        if not str(metric_name).endswith("Ms"):
            continue
        safe_ms = max(0, int(raw_value or 0))
        readable[metric_name] = {
            "ms": safe_ms,
            "seconds": round(safe_ms / 1000, 2),
            "minutes": round(safe_ms / 60000, 2),
        }
    return readable


def _attach_usage_metrics_readable(target: dict, metrics: dict):
    readable = _usage_metrics_readable(metrics)
    if readable:
        target["metricsReadable"] = readable


def _analysis_action_text_fingerprint(value, preview_length: int = 180) -> dict:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    payload = {
        "length": len(text),
        "sha1": hashlib.sha1(text.encode("utf-8")).hexdigest() if text else "",
        "preview": text[:preview_length],
    }
    if len(text) > preview_length:
        payload["truncated"] = True
    return payload


def _sanitize_analysis_action_value(value, depth: int = 0):
    if depth > 4:
        return str(type(value).__name__)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        text = re.sub(r"\s+", " ", value).strip()
        if len(text) > 500:
            return {
                "preview": text[:500],
                "length": len(text),
                "sha1": hashlib.sha1(text.encode("utf-8")).hexdigest(),
                "truncated": True,
            }
        return text
    if isinstance(value, list):
        return {
            "items": [_sanitize_analysis_action_value(item, depth + 1) for item in value[:25]],
            "count": len(value),
            "truncated": len(value) > 25,
        }
    if isinstance(value, dict):
        sanitized = {}
        for idx, (key, item) in enumerate(value.items()):
            if idx >= 40:
                sanitized["_truncated"] = True
                sanitized["_originalKeyCount"] = len(value)
                break
            safe_key = re.sub(r"[.#$/\[\]]+", "_", str(key or f"field_{idx}")).strip()[:80] or f"field_{idx}"
            sanitized[safe_key] = _sanitize_analysis_action_value(item, depth + 1)
        return sanitized
    return str(value)


def _collect_usage_focus_deltas(events: list[dict], item_type: str) -> dict:
    config = {
        "theme": {
            "keyField": "themeKey",
            "labelField": "themeLabel",
            "focusEvent": "theme_focus",
            "dwellEvent": "theme_dwell",
        },
        "code": {
            "keyField": "codeKey",
            "labelField": "codeLabel",
            "focusEvent": "code_focus",
            "dwellEvent": "code_dwell",
        },
    }.get(item_type)
    if config is None:
        return {}

    deltas: dict[str, dict] = {}
    for event in events:
        if not isinstance(event, dict):
            continue
        event_type = str(event.get("eventType") or "").strip()
        if event_type not in {config["focusEvent"], config["dwellEvent"]}:
            continue

        details = event.get("details") if isinstance(event.get("details"), dict) else {}
        item_key = _safe_usage_log_key(details.get(config["keyField"]), default="")
        if not item_key:
            continue

        label = str(details.get(config["labelField"]) or item_key).strip() or item_key
        page_step = event.get("pageStep") if isinstance(event.get("pageStep"), dict) else {}
        entry = deltas.setdefault(item_key, {
            config["keyField"]: item_key,
            config["labelField"]: label,
            "source": str(details.get("source") or "").strip(),
            "pageName": event.get("pageName"),
            "pagePath": event.get("pagePath"),
            "pageStepKey": page_step.get("stepKey"),
            "pageStepName": page_step.get("stepName"),
            "clientTimeZone": event.get("timezone"),
            "clicks": 0,
            "focusChanges": 0,
            "dwellMs": 0,
            "dwellSegments": 0,
            "firstSeenMs": None,
            "lastSeenMs": 0,
            "lastFocusMs": 0,
            "lastDwellMs": 0,
        })
        entry["pageName"] = event.get("pageName")
        entry["pagePath"] = event.get("pagePath")
        entry["pageStepKey"] = page_step.get("stepKey")
        entry["pageStepName"] = page_step.get("stepName")
        event_ms = max(0, int(event.get("timestampMs") or 0))
        if entry["firstSeenMs"] is None or (event_ms and event_ms < entry["firstSeenMs"]):
            entry["firstSeenMs"] = event_ms
        entry["lastSeenMs"] = max(entry["lastSeenMs"], event_ms)
        if item_type == "code":
            entry["themeKey"] = _safe_usage_log_key(details.get("themeKey"), default="unknown_theme")
            entry["themeLabel"] = str(details.get("themeLabel") or details.get("themeKey") or "").strip()

        if event_type == config["focusEvent"]:
            entry["clicks"] += 1
            entry["focusChanges"] += 1
            entry["lastFocusMs"] = max(entry["lastFocusMs"], event_ms)
        else:
            dwell_ms = max(0, int(details.get("dwellMs") or 0))
            entry["dwellMs"] += dwell_ms
            entry["dwellSegments"] += 1
            entry["lastDwellMs"] = max(entry["lastDwellMs"], event_ms)

    return deltas


def _usage_target_hash_key(parts: list[str], default: str = "target") -> str:
    safe_parts = [str(part or "") for part in parts]
    descriptor = "||".join(safe_parts)
    safe_prefix = _safe_usage_log_key("_".join(safe_parts), default=default)[:80]
    digest = hashlib.sha1(descriptor.encode("utf-8")).hexdigest()[:10]
    return f"{safe_prefix}_{digest}"


def _collect_usage_click_target_deltas(events: list[dict]) -> dict:
    deltas: dict[str, dict] = {}
    for event in events:
        if not isinstance(event, dict) or event.get("eventType") != "click":
            continue

        details = event.get("details") if isinstance(event.get("details"), dict) else {}
        element = details.get("element") if isinstance(details.get("element"), dict) else {}
        feature = str(details.get("feature") or "general").strip() or "general"
        action = str(details.get("action") or "click").strip() or "click"
        tag = str(element.get("tag") or "").strip()
        element_id = str(element.get("id") or "").strip()
        text = str(element.get("text") or "").strip()
        href = str(element.get("href") or "").strip()
        label = element_id or text or href or tag or "unknown"
        target_key = _usage_target_hash_key([feature, action, tag, element_id or text or href], default="click_target")
        page_step = event.get("pageStep") if isinstance(event.get("pageStep"), dict) else {}

        entry = deltas.setdefault(target_key, {
            "targetKey": target_key,
            "feature": feature,
            "action": action,
            "label": label,
            "element": {
                "tag": tag,
                "id": element_id,
                "type": element.get("type"),
                "name": element.get("name"),
                "href": href,
                "classes": element.get("classes") if isinstance(element.get("classes"), list) else [],
                "text": text,
            },
            "pageName": event.get("pageName"),
            "pagePath": event.get("pagePath"),
            "pageStepKey": page_step.get("stepKey"),
            "pageStepName": page_step.get("stepName"),
            "clientTimeZone": event.get("timezone"),
            "clicks": 0,
            "firstSeenMs": None,
            "lastSeenMs": 0,
        })
        entry["pageName"] = event.get("pageName")
        entry["pagePath"] = event.get("pagePath")
        entry["pageStepKey"] = page_step.get("stepKey")
        entry["pageStepName"] = page_step.get("stepName")
        event_ms = max(0, int(event.get("timestampMs") or 0))
        if entry["firstSeenMs"] is None or (event_ms and event_ms < entry["firstSeenMs"]):
            entry["firstSeenMs"] = event_ms
        entry["lastSeenMs"] = max(entry["lastSeenMs"], event_ms)
        entry["clicks"] += 1

    return deltas


def _is_usage_color_coded_block(color: str | None) -> bool:
    normalized = str(color or "").strip().lower()
    return bool(normalized and normalized not in {"#ffffff", "#fff", "#eeeeee", "#eee", "white", "transparent"})


def _collect_usage_visualization_block_deltas(events: list[dict]) -> dict:
    deltas: dict[str, dict] = {}
    tracked_events = {"visualization_block_focus", "visualization_block_dwell"}
    for event in events:
        if not isinstance(event, dict):
            continue
        event_type = str(event.get("eventType") or "").strip()
        if event_type not in tracked_events:
            continue

        details = event.get("details") if isinstance(event.get("details"), dict) else {}
        block_id = str(details.get("blockId") or "").strip()
        participant = str(details.get("participant") or "").strip()
        transcript_index = details.get("transcriptIndex")
        tag = str(details.get("tag") or "").strip()
        timestamp = str(details.get("timestamp") or "").strip()
        speaker = str(details.get("speaker") or "").strip()
        color = str(details.get("color") or "").strip().lower()
        dominant_theme = str(details.get("dominantTheme") or "").strip()
        view_mode = str(details.get("viewMode") or "").strip() or "timeline"
        selected_themes = details.get("selectedThemes") if isinstance(details.get("selectedThemes"), list) else []
        identity = block_id or "||".join([participant, str(transcript_index), timestamp, tag, speaker])
        block_key = _usage_target_hash_key(["block", identity, color, dominant_theme], default="visualization_block")
        page_step = event.get("pageStep") if isinstance(event.get("pageStep"), dict) else {}

        entry = deltas.setdefault(block_key, {
            "blockKey": block_key,
            "blockId": block_id or identity,
            "participant": participant,
            "transcriptIndex": transcript_index,
            "tag": tag,
            "timestamp": timestamp,
            "speaker": speaker,
            "color": color,
            "isColorCoded": _is_usage_color_coded_block(color),
            "dominantTheme": dominant_theme,
            "viewMode": view_mode,
            "selectedThemes": selected_themes,
            "pageName": event.get("pageName"),
            "pagePath": event.get("pagePath"),
            "pageStepKey": page_step.get("stepKey"),
            "pageStepName": page_step.get("stepName"),
            "clientTimeZone": event.get("timezone"),
            "clicks": 0,
            "coloredClicks": 0,
            "focusChanges": 0,
            "dwellMs": 0,
            "dwellSegments": 0,
            "firstSeenMs": None,
            "lastSeenMs": 0,
            "lastFocusMs": 0,
            "lastDwellMs": 0,
        })
        entry["pageName"] = event.get("pageName")
        entry["pagePath"] = event.get("pagePath")
        entry["pageStepKey"] = page_step.get("stepKey")
        entry["pageStepName"] = page_step.get("stepName")
        entry["viewMode"] = view_mode
        entry["selectedThemes"] = selected_themes
        event_ms = max(0, int(event.get("timestampMs") or 0))
        if entry["firstSeenMs"] is None or (event_ms and event_ms < entry["firstSeenMs"]):
            entry["firstSeenMs"] = event_ms
        entry["lastSeenMs"] = max(entry["lastSeenMs"], event_ms)

        if event_type == "visualization_block_focus":
            entry["clicks"] += 1
            entry["focusChanges"] += 1
            if entry["isColorCoded"]:
                entry["coloredClicks"] += 1
            entry["lastFocusMs"] = max(entry["lastFocusMs"], event_ms)
        else:
            dwell_ms = max(0, int(details.get("dwellMs") or 0))
            entry["dwellMs"] += dwell_ms
            entry["dwellSegments"] += 1
            entry["lastDwellMs"] = max(entry["lastDwellMs"], event_ms)

    return deltas


def _notes_action_details(previous_payload, next_payload) -> dict:
    before = previous_payload if isinstance(previous_payload, dict) else {}
    after = next_payload if isinstance(next_payload, dict) else {}
    before_keys = {str(key) for key in before.keys()}
    after_keys = {str(key) for key in after.keys()}
    return {
        "noteCountBefore": len(before_keys),
        "noteCountAfter": len(after_keys),
        "addedNoteCount": len(after_keys - before_keys),
        "removedNoteCount": len(before_keys - after_keys),
        "updatedNoteCount": sum(1 for key in before_keys & after_keys if before.get(key) != after.get(key)),
        "addedNoteKeys": sorted(after_keys - before_keys)[:10],
        "removedNoteKeys": sorted(before_keys - after_keys)[:10],
    }
