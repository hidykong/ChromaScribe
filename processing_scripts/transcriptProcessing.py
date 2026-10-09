"""Build the existing project transcript JSON from normalized upload records."""

# Support both module execution and the existing direct-script entry point.
if __package__ in (None, ""):
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import json
import os
from collections import Counter

from config import settings
from processing_scripts.transcriptIdentity import participant_id_for_entry
from processing_scripts.transcript_import import (
    SUPPORTED_TRANSCRIPT_EXTENSIONS,
    format_seconds_to_mm_ss,
    normalize_timestamp_to_mm_ss,
    parse_plain_transcript_content,
    parse_vtt_content,
    read_transcript_file,
    summarize_transcript,
)


INPUT_DIR = os.path.join(str(settings.data_dir), "static", "Uploaded_files", "uploads")
OUTPUT_DIR = os.path.join(str(settings.data_dir), "static", "Processed_files")
OUTPUT_JSON_FILENAME = "all_transcripts_processed.json"
SKIPPED_UPLOAD_DIRS = {"questions", "audio_storage", "audio"}
parse_vtt_time_to_mm_ss = normalize_timestamp_to_mm_ss


def create_structured_json(
    transcript_records,
    original_filename="",
    audio_filename=None,
    participant_id=None,
):
    """Keep the legacy document shape and add explicit import metadata."""
    if not transcript_records:
        return None
    if participant_id:
        for record in transcript_records:
            record["participantId"] = participant_id
    result = {
        "date": "unknown",
        "audiofile": audio_filename or None,
        "sourceFile": original_filename,
        "transcript": transcript_records,
        "importSummary": summarize_transcript(transcript_records),
    }
    if participant_id:
        result["participantId"] = participant_id
    return result


def _docx_text_filename(relative_filepath):
    base, _ = os.path.splitext(relative_filepath)
    return base + "_from_docx.txt"


def _normalize_relative_path(relative_filepath):
    return str(relative_filepath or "").replace("\\", "/").lstrip("/")


def _candidate_relative_paths(relative_filepath):
    normalized = _normalize_relative_path(relative_filepath)
    candidates = [normalized]
    if normalized.lower().endswith(".docx"):
        candidates.append(_docx_text_filename(normalized))
    return candidates


def _should_skip_uploaded_path(relative_filepath):
    parts = [part.lower() for part in _normalize_relative_path(relative_filepath).split("/") if part]
    return bool(parts and parts[0] in SKIPPED_UPLOAD_DIRS)


def _filemap_transcript_paths(file_map):
    paths = []
    for participant in (file_map or {}).get("participants", []):
        if not isinstance(participant, dict):
            continue
        transcript = participant.get("transcript") or {}
        relative_path = transcript.get("relativePath")
        if relative_path:
            paths.append(_normalize_relative_path(relative_path))
    return paths


def _discover_uploaded_transcript_paths(input_directory):
    discovered = []
    if not input_directory or not os.path.isdir(input_directory):
        return discovered
    for root, directories, files in os.walk(input_directory):
        directories[:] = [
            directory for directory in directories
            if directory.lower() not in SKIPPED_UPLOAD_DIRS
        ]
        for filename in sorted(files):
            if filename.lower().endswith(SUPPORTED_TRANSCRIPT_EXTENSIONS):
                relative_path = os.path.relpath(os.path.join(root, filename), input_directory)
                discovered.append(_normalize_relative_path(relative_path))
    return discovered


def transcript_paths_to_process(input_directory, file_map):
    """Include unmapped uploads while avoiding legacy DOCX conversion duplicates."""
    paths = _filemap_transcript_paths(file_map) + _discover_uploaded_transcript_paths(input_directory)
    docx_conversions = {
        _docx_text_filename(path)
        for path in paths
        if path.lower().endswith(".docx")
    }
    seen = set()
    result = []
    for path in paths:
        if path in seen or _should_skip_uploaded_path(path) or path in docx_conversions:
            continue
        seen.add(path)
        result.append(path)
    return result


def _resolve_transcript_path(input_directory, relative_path):
    upload_root = os.path.realpath(input_directory)
    for candidate in _candidate_relative_paths(relative_path):
        candidate_path = os.path.realpath(os.path.join(upload_root, candidate))
        if os.path.commonpath((upload_root, candidate_path)) != upload_root:
            continue
        if os.path.isfile(candidate_path):
            return candidate
    return None


def transcript_output_keys_by_path(input_directory, file_map):
    """Preserve legacy names unless folder uploads contain duplicate basenames."""
    resolved_paths = []
    for relative_path in transcript_paths_to_process(input_directory, file_map):
        resolved = _resolve_transcript_path(input_directory, relative_path)
        if resolved and resolved not in resolved_paths:
            resolved_paths.append(resolved)
    basename_counts = Counter(os.path.basename(path) for path in resolved_paths)
    return {
        path: os.path.basename(path) if basename_counts[os.path.basename(path)] == 1 else path
        for path in resolved_paths
    }


def expected_transcript_output_keys(input_directory, file_map):
    return set(transcript_output_keys_by_path(input_directory, file_map).values())


def _build_transcript_metadata_lookup(file_map):
    lookup = {}
    for participant in (file_map or {}).get("participants", []):
        if not isinstance(participant, dict):
            continue
        transcript = participant.get("transcript") or {}
        relative_path = transcript.get("relativePath")
        if not relative_path:
            continue
        audio = participant.get("audio") or {}
        audio_path = audio.get("relativePath") or audio.get("originalFilename")
        metadata = {
            "participantId": participant.get("participant") or participant.get("participantId"),
            "audioFilename": os.path.basename(_normalize_relative_path(audio_path)) if audio_path else None,
            "speakerRoles": transcript.get("speakerRoles") or {},
        }
        for candidate in _candidate_relative_paths(relative_path):
            lookup[candidate] = metadata
    return lookup


def _apply_speaker_roles(records, speaker_roles):
    if not isinstance(speaker_roles, dict):
        return
    for record in records:
        label = record["speakerLabel"]
        role = speaker_roles.get(label)
        if role not in ("interviewer", "participant", "unknown"):
            continue
        record["speakerRole"] = role
        record["speakerRoleInferred"] = False
        record["speaker"] = "Interviewer" if role == "interviewer" else label or "Unknown"


def _participant_ids_for_paths(output_keys, metadata_lookup):
    """Give unmapped uploads the same identity in the interface and AI pipeline."""
    participant_ids = {}
    mapped_paths = set()
    for relative_path in output_keys:
        metadata = metadata_lookup.get(relative_path) or {}
        participant_ids[relative_path] = participant_id_for_entry(relative_path, {
            "participantId": metadata.get("participantId"),
            "audiofile": metadata.get("audioFilename"),
        })
        if metadata.get("participantId"):
            mapped_paths.add(relative_path)

    identity_counts = Counter(participant_ids.values())
    used_ids = {participant_ids[path] for path in mapped_paths}
    for relative_path in sorted(participant_ids):
        if relative_path in mapped_paths:
            continue
        participant_id = participant_ids[relative_path]
        if identity_counts[participant_id] > 1:
            participant_id = os.path.splitext(relative_path)[0]
        base_id = participant_id
        suffix = 2
        while participant_id in used_ids:
            participant_id = f"{base_id} ({suffix})"
            suffix += 1
        participant_ids[relative_path] = participant_id
        used_ids.add(participant_id)
    return participant_ids


def doc_processing(input_directory=INPUT_DIR, output_directory=OUTPUT_DIR, file_map=None):
    """Parse each transcript and retain its confirmed participant/audio pairing."""
    os.makedirs(output_directory, exist_ok=True)
    metadata_lookup = _build_transcript_metadata_lookup(file_map)
    output_keys = transcript_output_keys_by_path(input_directory, file_map)
    participant_ids = _participant_ids_for_paths(output_keys, metadata_lookup)
    processed = {}
    errors = []
    for requested_path in transcript_paths_to_process(input_directory, file_map):
        relative_path = _resolve_transcript_path(input_directory, requested_path)
        if not relative_path:
            errors.append(f"{requested_path}: the uploaded file is missing. Upload it again or update its assignment.")
            continue
        metadata = metadata_lookup.get(requested_path) or metadata_lookup.get(relative_path) or {}
        try:
            records = read_transcript_file(
                os.path.join(input_directory, relative_path),
                source_name=requested_path,
            )
            _apply_speaker_roles(records, metadata.get("speakerRoles"))
            for record in records:
                record["sourceFile"] = relative_path
            document = create_structured_json(
                records,
                original_filename=relative_path,
                audio_filename=metadata.get("audioFilename"),
                participant_id=participant_ids[relative_path],
            )
            processed[output_keys[relative_path]] = document
        except (OSError, ValueError, KeyError) as error:
            errors.append(f"{relative_path}: {error}")

    if errors:
        raise ValueError("Some transcripts could not be processed. " + " ".join(errors))
    if not processed:
        raise ValueError("No readable transcripts were found. Upload a DOCX, TXT, VTT or SRT transcript first.")

    output_path = os.path.join(output_directory, OUTPUT_JSON_FILENAME)
    with open(output_path, "w", encoding="utf-8") as output_file:
        json.dump(processed, output_file, indent=2, ensure_ascii=False)
    return processed


if __name__ == "__main__":
    processed_data = doc_processing()
    print(f"Processed {len(processed_data)} transcript files.")
