"""Keep imported participant and segment identities consistent across AI steps."""

import os
import re


def legacy_participant_id(value):
    """Read older P1 / Participant 1 labels without matching unrelated filenames."""
    match = re.search(
        r"(?:^|[^A-Za-z0-9])(?:participant\s*|p[\s_-]*|pt[\s_-]*)0*(\d+)(?=$|[^A-Za-z0-9])",
        str(value or ""),
        flags=re.IGNORECASE,
    )
    return f"P{int(match.group(1))}" if match else ""


def normalize_participant_id(value):
    """Explicit participant IDs may be numbers, legacy labels or user-chosen names."""
    text = str(value or "").strip()
    if text.isdecimal():
        return f"P{int(text)}"
    legacy_match = re.fullmatch(
        r"(?:participant\s*|p[\s_-]*|pt[\s_-]*)0*(\d+)",
        text,
        re.IGNORECASE,
    )
    if legacy_match:
        return f"P{int(legacy_match.group(1))}"
    return text


def participant_id_for_entry(file_name, content, entry=None):
    """Prefer the upload mapping; filenames remain a fallback for older projects."""
    content = content if isinstance(content, dict) else {}
    entry = entry if isinstance(entry, dict) else {}
    explicit_ids = (
        entry.get("participantId"),
        entry.get("participant"),
        content.get("participantId"),
        content.get("participant"),
    )
    for value in explicit_ids:
        participant_id = normalize_participant_id(value)
        if participant_id:
            return participant_id

    for value in (entry.get("speaker"), content.get("audiofile"), file_name):
        participant_id = legacy_participant_id(value)
        if participant_id:
            return participant_id

    # An older import may have neither a mapping nor a conventional filename.
    # Keep that file's answers available instead of silently dropping them.
    source_file = os.path.basename(str(file_name or "").replace("\\", "/"))
    return os.path.splitext(source_file)[0] or "Unknown"


def participant_display_label(participant_id):
    participant_id = normalize_participant_id(participant_id)
    if re.fullmatch(r"P\d+", participant_id):
        return f"Participant {int(participant_id[1:])}"
    return f"Participant {participant_id}"


def excerpt_source_metadata(file_name, content, entry):
    """Copy only known source fields. Missing timing remains missing."""
    participant_id = participant_id_for_entry(file_name, content, entry)
    source_file = str(
        entry.get("sourceFile") or content.get("sourceFile") or file_name or ""
    ).replace("\\", "/").strip()
    metadata = {
        "participant": participant_id,
        "participantId": participant_id,
        "sourceFile": source_file,
        "source_file": source_file,
        "timestamp": entry.get("timestamp") or "",
        "cueText": str(entry.get("script") or ""),
    }
    for field in ("segmentId", "startSeconds", "endSeconds", "speakerLabel", "speakerRole"):
        if field in entry:
            metadata[field] = entry[field]
    return metadata
