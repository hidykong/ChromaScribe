"""Validate transcript imports before replacing the stored source file."""

import os
import tempfile
from pathlib import Path
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile

from processing_scripts.transcript_import import (
    SUPPORTED_TRANSCRIPT_EXTENSIONS,
    read_transcript_file,
    summarize_transcript,
)


def save_transcript_upload(upload, destination, source_name):
    destination = Path(destination)
    extension = destination.suffix.lower()
    if extension not in SUPPORTED_TRANSCRIPT_EXTENSIONS:
        raise ValueError("Use a DOCX, TXT, VTT, or SRT transcript.")
    if Path(upload.filename).suffix.lower() != extension:
        raise ValueError("The uploaded filename and destination must use the same file type.")

    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_path = tempfile.mkstemp(
        prefix=".transcript-import-", suffix=extension, dir=destination.parent
    )
    os.close(descriptor)
    try:
        upload.save(temporary_path)
        try:
            records = read_transcript_file(temporary_path, source_name=source_name)
        except (BadZipFile, ParseError, KeyError) as error:
            raise ValueError("This Word file could not be read. Save it as DOCX and try again.") from error
        if not records:
            raise ValueError("No transcript dialogue was found. Check the file and try again.")

        summary = summarize_transcript(records)
        summary["format"] = extension.lstrip(".").upper()
        preview = [
            {
                "speakerLabel": record.get("speakerLabel", ""),
                "speakerRole": record.get("speakerRole", "unknown"),
                "timestamp": record.get("timestamp", ""),
                "script": record.get("script", ""),
            }
            for record in records[:8]
        ]
        # Parsing failures leave both the previous source and its analysis intact.
        os.replace(temporary_path, destination)
        return {"importSummary": summary, "preview": preview}
    finally:
        if os.path.exists(temporary_path):
            os.remove(temporary_path)
