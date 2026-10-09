#!/usr/bin/env python3
"""Clear transient ChromaScribe runtime state for a project via the app API."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request


DEFAULT_BASE_URL = "http://127.0.0.1:5001"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Clear per-project session/cache state through /api/maintenance/project_runtime/clear."
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("CHROMASCRIBE_PUBLIC_BASE_URL") or DEFAULT_BASE_URL,
        help="Base URL of the local app.",
    )
    parser.add_argument("--project-id", required=True, help="Project ID, for example project_2.")
    parser.add_argument("--reset-filemap", action="store_true", help="Do not preserve the best existing filemap.")
    parser.add_argument("--clear-notes", action="store_true", help="Also delete notes.json.")
    parser.add_argument("--clear-generated-outputs", action="store_true", help="Delete generated output files.")
    parser.add_argument("--clear-inputs", action="store_true", help="Delete uploaded transcript/audio inputs.")
    parser.add_argument("--clear-all", action="store_true", help="Delete runtime, generated outputs, and inputs.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    base_url = args.base_url.rstrip("/")
    url = f"{base_url}/api/maintenance/project_runtime/clear"

    payload = {
        "projectId": args.project_id,
        "resetFileMap": args.reset_filemap,
        "clearNotes": args.clear_notes,
        "clearGeneratedOutputs": args.clear_generated_outputs,
        "clearInputs": args.clear_inputs,
        "clearAll": args.clear_all,
    }

    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            body = response.read().decode("utf-8")
            print(json.dumps(json.loads(body), indent=2))
            return 0
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        print(body or f"HTTP {error.code}", file=sys.stderr)
        return 1
    except urllib.error.URLError as error:
        print(f"Request failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
