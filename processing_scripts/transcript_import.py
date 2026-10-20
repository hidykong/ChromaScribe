"""Read common interview exports without requiring a particular transcript layout."""

import hashlib
import html
from pathlib import Path
import re
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile


SUPPORTED_TRANSCRIPT_EXTENSIONS = (".txt", ".vtt", ".srt", ".docx")
TIME_PATTERN = r"(?:\d{1,3}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?"
CUE_TIMING = re.compile(
    rf"^\s*(?P<start>{TIME_PATTERN})\s*-->\s*(?P<end>{TIME_PATTERN})(?:\s+.*)?$"
)
WORD_NAMESPACE = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def timestamp_seconds(value):
    """Return a real timestamp in seconds, or None when timing is absent."""
    parts = str(value or "").strip().replace(",", ".").split(":")
    if len(parts) not in (2, 3):
        return None
    try:
        seconds = float(parts[-1])
        minutes = int(parts[-2])
        hours = int(parts[0]) if len(parts) == 3 else 0
    except ValueError:
        return None
    if seconds < 0 or seconds >= 60 or minutes < 0 or hours < 0:
        return None
    if len(parts) == 3 and minutes >= 60:
        return None
    return hours * 3600 + minutes * 60 + seconds


def format_seconds_to_mm_ss(total_seconds):
    if total_seconds is None:
        return ""
    whole_seconds = max(0, int(total_seconds))
    return f"{whole_seconds // 60:02d}:{whole_seconds % 60:02d}"


def normalize_timestamp_to_mm_ss(value):
    return format_seconds_to_mm_ss(timestamp_seconds(value))


def _known_speaker_role(label):
    normalized = re.sub(r"\s*[\[(].*?[\])]", "", label).strip().lower()
    if re.fullmatch(r"(?:interviewer|moderator|facilitator|researcher)(?:\s*\d+)?", normalized):
        return "interviewer"
    if re.fullmatch(r"(?:q|question)\s*\d*", normalized):
        return "interviewer"
    if re.fullmatch(r"(?:participant|respondent|interviewee)(?:\s*\d+)?", normalized):
        return "participant"
    if re.fullmatch(r"(?:a|answer|p)\s*\d*", normalized):
        return "participant"
    return "unknown"


def _looks_like_speaker_label(label):
    label = str(label or "").strip()
    if not label or len(label) > 100 or "?" in label:
        return False
    if _known_speaker_role(label) != "unknown":
        return True
    if re.fullmatch(r"(?:speaker|spk)\s*\d+", label, re.IGNORECASE):
        return True
    # Names can include non-Latin letters, initials, apostrophes and hyphens.
    if not all(character.isalpha() or character in " .'’-()[]" for character in label):
        return False
    words = label.split()
    if len(words) == 1:
        return True
    if len(words) > 6:
        return False
    name_connectors = {"de", "del", "der", "van", "von", "da", "dos", "al"}
    return all(
        word in name_connectors or word[0].isupper() or word.lower() == word.upper()
        for word in words
    )


def _record(script, speaker, source_line, start=None, end=None):
    return {
        "speaker": speaker or "Unknown",
        "speakerLabel": speaker or "",
        "speakerRole": _known_speaker_role(speaker or ""),
        "timestamp": format_seconds_to_mm_ss(start),
        "startSeconds": start,
        "endSeconds": end,
        "script": script.strip(),
        "sourceLine": source_line,
    }


def _finalize_records(records, source_name):
    """Retain existing interviewer inference while exposing that it was inferred."""
    speaker_stats = {}
    known_interviewers = set()
    for record in records:
        label = record["speakerLabel"]
        if not label:
            continue
        if record["speakerRole"] == "interviewer":
            known_interviewers.add(label)
        counts = speaker_stats.setdefault(label, {"total": 0, "questions": 0})
        counts["total"] += 1
        counts["questions"] += int("?" in record["script"] or "？" in record["script"])

    inferred_interviewers = set()
    candidates = [label for label in speaker_stats if _known_speaker_role(label) == "unknown"]
    if not known_interviewers and candidates:
        best_label = max(
            candidates,
            key=lambda label: (
                speaker_stats[label]["questions"],
                speaker_stats[label]["questions"] / speaker_stats[label]["total"],
            ),
        )
        best = speaker_stats[best_label]
        first_label = next(iter(speaker_stats))
        if best["questions"] >= 2 or (
            best_label == first_label
            and best["questions"] >= 1
            and best["questions"] / best["total"] >= 0.30
        ):
            inferred_interviewers.add(best_label)

    occurrences = {}
    for index, record in enumerate(records):
        label = record["speakerLabel"]
        if label in known_interviewers or label in inferred_interviewers:
            record["speaker"] = "Interviewer"
            record["speakerRole"] = "interviewer"
            record["speakerRoleInferred"] = label in inferred_interviewers
        source_line = record["sourceLine"]
        occurrence = occurrences.get(source_line, 0)
        occurrences[source_line] = occurrence + 1
        identity = f"{source_name}\n{source_line}\n{occurrence}"
        record["segmentId"] = "segment-" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24]
        record["lineNumber"] = index + 1
        record["transcriptIndex"] = index
    return records


def parse_plain_transcript_content(text_content, source_name=""):
    """Read speaker turns or paragraphs; leave unknown speakers and times unknown."""
    records = []
    current_lines = []
    speaker = ""
    start = None
    source_line = 1

    def flush():
        nonlocal current_lines
        if current_lines:
            records.append(_record("\n".join(current_lines), speaker, source_line, start))
        current_lines = []

    for line_number, raw_line in enumerate(str(text_content or "").splitlines(), start=1):
        line = raw_line.strip()
        if not line:
            # Blank lines delimit unlabelled paragraphs, not wrapped speech.
            if not speaker:
                flush()
            continue

        speaker_time = re.fullmatch(
            rf"(?P<speaker>.+?)\s+\[?(?P<time>{TIME_PATTERN})\]?", line
        )
        leading_time = re.fullmatch(
            rf"\[?(?P<time>{TIME_PATTERN})\]?\s+(?P<speaker>[^:]+):?\s*", line
        )
        timestamp_only = re.fullmatch(rf"\[?(?P<time>{TIME_PATTERN})\]?", line)
        timed_dialogue = re.fullmatch(
            rf"\[?(?P<time>{TIME_PATTERN})\]?\s+(?P<speaker>[^:]+):\s*(?P<text>.+)", line
        )
        colon_turn = re.fullmatch(r"(?P<speaker>[^:\n]{1,100}):\s*(?P<text>.*)", line)

        if timed_dialogue and _looks_like_speaker_label(timed_dialogue["speaker"]):
            flush()
            speaker = timed_dialogue["speaker"].strip()
            start = timestamp_seconds(timed_dialogue["time"])
            source_line = line_number
            current_lines.append(timed_dialogue["text"])
        elif (speaker_time or leading_time) and _looks_like_speaker_label(
            (speaker_time or leading_time)["speaker"]
        ):
            flush()
            match = speaker_time or leading_time
            speaker = match["speaker"].strip().rstrip(":")
            start = timestamp_seconds(match["time"])
            source_line = line_number
        elif timestamp_only:
            flush()
            start = timestamp_seconds(timestamp_only["time"])
            source_line = line_number
        elif colon_turn and _looks_like_speaker_label(colon_turn["speaker"]):
            flush()
            speaker = colon_turn["speaker"].strip()
            start = None
            source_line = line_number
            if colon_turn["text"]:
                current_lines.append(colon_turn["text"])
        elif _known_speaker_role(line) != "unknown" or re.fullmatch(
            r"(?:speaker|spk)\s*\d+", line, re.IGNORECASE
        ):
            flush()
            speaker = line
            start = None
            source_line = line_number
        else:
            if not current_lines:
                source_line = line_number
            current_lines.append(raw_line.strip())

    flush()
    return _finalize_records(records, source_name)


def _clean_caption_text(text):
    # Remove caption formatting, not arbitrary angle-bracketed spoken text.
    text = re.sub(r"</?(?:c|i|b|u)(?:\.[^>]*)?>", "", text, flags=re.IGNORECASE)
    text = re.sub(rf"<{TIME_PATTERN}>", "", text)
    return html.unescape(text).strip()


def parse_vtt_content(text_content, source_name=""):
    """Read VTT/SRT cues, keeping numeric speech and both ends of each interval."""
    lines = str(text_content or "").lstrip("\ufeff").splitlines()
    for line in lines:
        if "-->" in line and re.match(r"\s*\d", line) and not CUE_TIMING.match(line):
            raise ValueError("A transcript timestamp could not be read. Check the time ranges in the VTT or SRT file.")
    timing_lines = [(index, CUE_TIMING.match(line)) for index, line in enumerate(lines)]
    timing_lines = [(index, match) for index, match in timing_lines if match]
    first_identifier = ""
    if timing_lines:
        preceding_lines = [line.strip() for line in lines[:timing_lines[0][0]] if line.strip()]
        if preceding_lines and not preceding_lines[-1].startswith("WEBVTT"):
            first_identifier = preceding_lines[-1]
    records = []
    for cue_number, (timing_index, timing) in enumerate(timing_lines):
        next_index = timing_lines[cue_number + 1][0] if cue_number + 1 < len(timing_lines) else len(lines)
        body = lines[timing_index + 1:next_index]
        while body and not body[-1].strip():
            body.pop()
        if next_index < len(lines) and body:
            # The line immediately before the next timing may be its cue ID.
            previous_line = body[-2].strip() if len(body) > 1 else ""
            candidate_identifier = body[-1].strip()
            has_numeric_identifiers = first_identifier.isdigit() and candidate_identifier.isdigit()
            has_named_identifiers = (
                first_identifier
                and not first_identifier.isdigit()
                and ":" not in candidate_identifier
            )
            if not previous_line and (has_numeric_identifiers or has_named_identifiers):
                body = body[:-1]
        while body and not body[-1].strip():
            body.pop()
        while body and not body[0].strip():
            body.pop(0)
        # NOTE/STYLE blocks after a cue are metadata, never interview dialogue.
        for index, line in enumerate(body):
            if re.match(r"^(?:NOTE(?:\s|$)|STYLE$|REGION$)", line.strip()):
                body = body[:index]
                break
        text = "\n".join(line.strip() for line in body if line.strip())
        start = timestamp_seconds(timing["start"])
        end = timestamp_seconds(timing["end"])
        if start is None or end is None or end < start:
            raise ValueError("A transcript segment has an invalid time range. Check its start and end times.")
        voices = list(re.finditer(
            r"<v(?:\.[^ >]+)?\s+([^>]+)>(.*?)(?:</v>|(?=<v)|$)",
            text,
            re.IGNORECASE | re.DOTALL,
        ))
        if voices:
            previous_end = 0
            for voice in voices:
                unlabelled_text = _clean_caption_text(text[previous_end:voice.start()])
                if unlabelled_text:
                    records.append(_record(unlabelled_text, "", timing_index + 1, start, end))
                script = _clean_caption_text(voice[2])
                if script:
                    records.append(_record(script, voice[1].strip(), timing_index + 1, start, end))
                previous_end = voice.end()
            trailing_text = _clean_caption_text(text[previous_end:])
            if trailing_text:
                records.append(_record(trailing_text, "", timing_index + 1, start, end))
            continue
        speaker = ""
        text = _clean_caption_text(text)
        speaker_match = re.match(r"^([^:\n]{1,100}):\s*([\s\S]*)$", text)
        if speaker_match and _looks_like_speaker_label(speaker_match[1]):
            speaker, text = speaker_match[1].strip(), speaker_match[2]
        if text.strip():
            records.append(_record(text, speaker, timing_index + 1, start, end))
    return _finalize_records(records, source_name)


def _paragraph_text(element):
    parts = []
    for node in element.iter():
        if node.tag == WORD_NAMESPACE + "t":
            parts.append(node.text or "")
        elif node.tag == WORD_NAMESPACE + "tab":
            parts.append("\t")
        elif node.tag in (WORD_NAMESPACE + "br", WORD_NAMESPACE + "cr"):
            parts.append("\n")
    return "".join(parts)


def _word_table_row_cells(row):
    cells = []
    for cell in row.findall(WORD_NAMESPACE + "tc"):
        paragraphs = cell.findall(WORD_NAMESPACE + "p")
        cells.append("\n".join(_paragraph_text(paragraph) for paragraph in paragraphs))
    return cells


def _format_transcript_table_row(cells, columns):
    if columns and len(cells) > max(columns["speaker"], columns["text"]):
        label = cells[columns["speaker"]].strip()
        speech = cells[columns["text"]]
        time_column = columns["time"]
        time_value = ""
        if time_column is not None and time_column < len(cells):
            time_value = cells[time_column].strip()
        prefix = f"{time_value} " if timestamp_seconds(time_value) is not None else ""
        if label:
            return f"{prefix}{label}: {speech}"
        return speech

    if len(cells) == 2 and _looks_like_speaker_label(cells[0].strip()):
        return f"{cells[0].strip()}: {cells[1]}"

    # Preserve unfamiliar table contents for the import preview.
    return "\n".join(cells)


def _transcript_table_blocks(table):
    blocks = []
    columns = None
    text_headers = {"text", "transcript", "dialogue", "speech", "content", "utterance"}
    for row in table.findall(WORD_NAMESPACE + "tr"):
        cells = _word_table_row_cells(row)
        normalized = [cell.strip().lower() for cell in cells]
        if "speaker" in normalized and any(cell in text_headers for cell in normalized):
            columns = {
                "speaker": normalized.index("speaker"),
                "text": next(index for index, cell in enumerate(normalized) if cell in text_headers),
                "time": next(
                    (index for index, cell in enumerate(normalized) if cell in {"time", "timestamp", "start"}),
                    None,
                ),
            }
            continue
        blocks.append(_format_transcript_table_row(cells, columns))
    return blocks


def read_docx_text(path):
    """Read paragraphs and simple speaker/text tables in document order."""
    with ZipFile(path) as archive:
        document = ElementTree.fromstring(archive.read("word/document.xml"))
    body = document.find(WORD_NAMESPACE + "body")
    blocks = []
    for element in body if body is not None else []:
        if element.tag == WORD_NAMESPACE + "p":
            blocks.append(_paragraph_text(element))
        elif element.tag == WORD_NAMESPACE + "tbl":
            blocks.extend(_transcript_table_blocks(element))
    return "\n\n".join(blocks)


def read_transcript_file(path, source_name=None):
    path = Path(path)
    if path.suffix.lower() not in SUPPORTED_TRANSCRIPT_EXTENSIONS:
        raise ValueError("Use a DOCX, TXT, VTT or SRT transcript.")
    if path.suffix.lower() == ".docx":
        try:
            content = read_docx_text(path)
        except (BadZipFile, KeyError, ElementTree.ParseError) as error:
            raise ValueError(
                "This Word file could not be read. Open it in Word and save a new DOCX copy, "
                "then upload it again."
            ) from error
    else:
        raw = path.read_bytes()
        encoding = "utf-16" if raw.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"
        try:
            content = raw.decode(encoding)
        except UnicodeDecodeError as error:
            raise ValueError(
                "This text file could not be read. Save it as UTF-8 or UTF-16 and upload it again."
            ) from error
    source_name = source_name or path.name
    has_cue_timing = any(CUE_TIMING.match(line) for line in content.splitlines())
    is_caption = path.suffix.lower() in (".vtt", ".srt") or content.lstrip().startswith("WEBVTT")
    if has_cue_timing or is_caption:
        records = parse_vtt_content(content, source_name)
    else:
        records = parse_plain_transcript_content(content, source_name)
    if not records:
        raise ValueError(
            "No transcript segments were found. Check that the file contains selectable transcript text "
            "and valid timestamps if it is a VTT or SRT file."
        )
    return records


def summarize_transcript(records):
    timed_count = sum(record.get("startSeconds") is not None for record in records)
    warnings = []
    if timed_count < len(records):
        warnings.append(
            "Some or all segments have no timestamps. Tagging and coding still work; "
            "audio seeking is unavailable for those segments."
        )
    if any(not record.get("speakerLabel") for record in records):
        warnings.append(
            "Some speakers could not be identified. Review the transcript before tagging questions and answers."
        )
    if any(record.get("speakerRoleInferred") for record in records):
        warnings.append(
            "The interviewer role was inferred from the dialogue. Review the speaker roles before tagging."
        )
    if records and not any(record.get("speakerRole") == "interviewer" for record in records):
        warnings.append(
            "No interviewer was identified. Review the dialogue and question tags "
            "before relying on automatic question matching."
        )
    speakers = {}
    for record in records:
        label = record.get("speakerLabel")
        if label and label not in speakers:
            speakers[label] = {
                "label": label,
                "role": record.get("speakerRole", "unknown"),
                "inferred": bool(record.get("speakerRoleInferred")),
            }
    return {
        "segmentCount": len(records),
        "speakers": list(speakers.values()),
        "timedSegmentCount": timed_count,
        "hasTimestamps": timed_count > 0,
        "warnings": warnings,
    }
