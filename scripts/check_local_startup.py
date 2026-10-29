#!/usr/bin/env python3
"""Check local startup and browser imports using temporary, fictional demo data.

Requires the application's dependencies and Node.js 22. No API key, model server,
.env file, existing project data, or internal test fixtures are used.
"""

import json
import os
from pathlib import Path
import subprocess
import sys
from html.parser import HTMLParser
from tempfile import TemporaryDirectory
from unittest.mock import patch

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]


class ModuleScripts(HTMLParser):
    """Collect active module scripts; HTML comments are ignored by the parser."""

    def __init__(self):
        super().__init__()
        self.scripts = []
        self.current_script = None

    def handle_starttag(self, tag, attributes):
        attributes = dict(attributes)
        if tag == "script" and attributes.get("type") == "module":
            self.current_script = {"src": attributes.get("src"), "source": ""}

    def handle_data(self, data):
        if self.current_script is not None:
            self.current_script["source"] += data

    def handle_endtag(self, tag):
        if tag == "script" and self.current_script is not None:
            self.scripts.append(self.current_script)
            self.current_script = None


def read_page(client, route):
    response = client.get(route, follow_redirects=True)
    if response.status_code != 200:
        raise RuntimeError(f"{route} returned HTTP {response.status_code}")
    parser = ModuleScripts()
    parser.feed(response.get_data(as_text=True))
    return {"path": response.request.path, "scripts": parser.scripts}


def check_application(data_directory):
    os.environ.update({
        "CHROMASCRIBE_LOAD_DOTENV": "0",
        "CHROMASCRIBE_DATA_DIR": data_directory,
        "CHROMASCRIBE_DEBUG": "false",
        "LLM_BASE_URL": "http://127.0.0.1:1/v1",
        "LLM_MODEL": "offline-startup-check",
        "LLM_API_KEY": "",
    })
    sys.path.insert(0, str(REPOSITORY_ROOT))
    from app import app

    app.config["TESTING"] = True
    client = app.test_client()
    pages = [read_page(client, route) for route in ("/", "/llm-setup", "/data-policy")]
    response = client.post("/api/prepare_new_project")
    if response.status_code != 200:
        raise RuntimeError("Could not create a temporary local project")
    pages.append(read_page(client, "/fileManager"))

    response = client.post("/api/start_demo", follow_redirects=True)
    if response.status_code != 200:
        raise RuntimeError("Could not create the fictional demo project")
    demo_routes = (
        "/demo/fileManager", "/demo/themes", "/demo/themes/edit",
        "/demo/transcriptmode", "/demo/transcriptmodedetail?participant=P3",
        "/demo/visualization", "/demo/demographics/choose-attributes",
        "/demo/demographics/edit-attributes", "/demo/demographics/demographics-manager",
    )
    pages.extend(read_page(client, route) for route in demo_routes)
    return pages


def main():
    with TemporaryDirectory(prefix="chromascribe-startup-check-") as data_directory:
        # Fail immediately if a startup or page handler unexpectedly makes a network request.
        with patch("socket.socket.connect", side_effect=RuntimeError("Network access is disabled in this check")):
            pages = check_application(data_directory)
        subprocess.run(
            ["node", "--experimental-vm-modules", str(REPOSITORY_ROOT / "scripts/check_browser_imports.mjs"), str(REPOSITORY_ROOT)],
            input=json.dumps(pages), text=True, check=True,
        )
        print(f"Local startup passed; checked {len(pages)} pages without Firebase or AI requests.")


if __name__ == "__main__":
    main()
