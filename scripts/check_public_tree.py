#!/usr/bin/env python3
"""Reject private files and recognizable credentials without printing their contents.

This checks a candidate tree, not Git history or credential validity.
"""

import argparse
import re
import subprocess
from pathlib import Path

PRIVATE_PREFIXES = (
    ".private/",
    "notes/",
    "internal notes/",
    "tests/",
    "venv/",
    ".venv/",
    ".idea/",
    "projects/",
    "intermediate_files/",
    "static/User_projects/",
    "static/Demo_project/",
    "static/Uploaded_files/",
    "static/Processed_files/",
    "static/audio_storage/",
    "static/user-imported-files/",
    ".config/gcloud/",
)
INTERNAL_ONLY_FILES = {
    "Procfile",
    "deploy.sh",
    "up.sh",
    "tmux_boot.sh",
    "scripts/run_tests.py",
    "scripts/migrate_private_storage.py",
    "scripts/provision_study_accounts.py",
    "scripts/delete_legacy_usage_logs.py",
    "processing_scripts/sample.py",
    "processing_scripts/tag_answers.py",
    "processing_scripts/possibleQuestionScript.txt",
    "processing_scripts/questionsTag.json",
    "possibleAnswerScript.json",
    "answersTag.json",
    "static/sender.php",
    "static/stemDict.json",
    "static/code_groups.json",
    "static/images/chromaScibeSetup1.png",
    "static/images/chromaScibeSetup2.png",
}
PUBLIC_MARKDOWN = {
    "README.md",
    "README-team-setup.md",
    "README-storage-and-analytics.md",
    "README-frontend.md",
}
CREDENTIAL_DIRECTORIES = {".aws", ".ssh", ".azure", ".gcloud"}
CREDENTIAL_EXTENSIONS = {".pem", ".key", ".p8", ".p12", ".pfx", ".jks", ".keystore"}
CREDENTIAL_FILENAMES = {
    "credentials",
    "credentials.json",
    "credentials.yaml",
    "credentials.yml",
    "credentials.ini",
    "credentials.toml",
}
CREDENTIAL_JSON_NAMES = re.compile(
    r"(?:service[-_]?account|firebase[-_]?credentials|firebase[-_]?adminsdk|client[-_]?secret)",
    re.IGNORECASE,
)
SECRET_FIELD_PATTERN = (
    rb"(?:[A-Z][A-Z0-9]*_)*"
    rb"(?:API[_-]?KEY|SECRET[_-]?KEY|PRIVATE[_-]?KEY|SECRET[_-]?ACCESS[_-]?KEY|"
    rb"ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|CLIENT[_-]?SECRET|PASSWORD)"
)
SECRET_VALUE_PATTERN = rb"[A-Za-z0-9_./+=-]{24,}"
SECRET_PATTERNS = (
    re.compile(rb"-----BEGIN " + rb"(?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----"),
    re.compile(rb"\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{30,}"),
    re.compile(rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    re.compile(rb"\bsk-[A-Za-z0-9_-]{24,}"),
    re.compile(rb"\bAIza[A-Za-z0-9_-]{35}\b"),
    re.compile(rb"\bgsk_[A-Za-z0-9_-]{24,}"),
    re.compile(rb"\bAQ\.[A-Za-z0-9_-]{32,}"),
    # Quoted values cover JSON, YAML, and assignments in source files.
    re.compile(
        rb"(?i)\b" + SECRET_FIELD_PATTERN + rb"[\"']?\s*[:=]\s*([\"'])"
        + SECRET_VALUE_PATTERN + rb"\1"
    ),
    # Environment exports may contain an unquoted value; blank template fields pass.
    re.compile(
        rb"(?m)^[ \t]*(?:export[ \t]+)?" + SECRET_FIELD_PATTERN + rb"[ \t]*=[ \t]*"
        + SECRET_VALUE_PATTERN + rb"[ \t]*(?:#.*)?$"
    ),
)


def is_credential_file(path: Path) -> bool:
    """Catch credential exports even when someone force-adds an ignored file."""
    if any(part.lower() in CREDENTIAL_DIRECTORIES for part in path.parts):
        return True
    if path.suffix.lower() in CREDENTIAL_EXTENSIONS:
        return True
    if path.name.lower() in CREDENTIAL_FILENAMES:
        return True
    return path.suffix.lower() == ".json" and bool(CREDENTIAL_JSON_NAMES.search(path.name))


def tracked_paths(root: Path) -> list[str]:
    result = subprocess.check_output(["git", "-C", str(root), "ls-files", "-z"])
    return [path for path in result.decode().split("\0") if path]


def requires_publication_review(name: str) -> bool:
    """Flag private paths and files whose redistribution needs a separate review."""
    path = Path(name)

    if name in INTERNAL_ONLY_FILES or name.startswith(PRIVATE_PREFIXES):
        return True
    if any(part.startswith(".venv") for part in path.parts):
        return True
    if path.name.startswith(".env") and name != ".env.template":
        return True
    if is_credential_file(path):
        return True
    if path.suffix == ".md" and name not in PUBLIC_MARKDOWN:
        return True
    if name.startswith("study_credentials/") and not name.endswith(".example.csv"):
        return True
    if path.suffix.lower() in {".m4a", ".mp3", ".wav", ".pdf", ".docx"}:
        return True

    return False


def check_tree(root: Path, paths: list[str]) -> list[str]:
    findings = []
    for name in paths:
        path = root / name
        if requires_publication_review(name):
            findings.append(f"Private or unreviewed file: {name}")
            continue
        if path.is_symlink():
            findings.append(f"Review symlink before publication: {name}")
            continue
        if not path.is_file():
            findings.append(f"Missing candidate file: {name}")
            continue
        content = path.read_bytes()
        if any(pattern.search(content) for pattern in SECRET_PATTERNS):
            findings.append(f"Possible credential: {name}")
    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument(
        "--all-files",
        action="store_true",
        help="Scan an exported tree without Git metadata.",
    )
    args = parser.parse_args()
    root = args.root.resolve()
    if args.all_files:
        paths = []
        for path in root.rglob("*"):
            if path.is_file() or path.is_symlink():
                relative_path = str(path.relative_to(root))
                paths.append(relative_path)
    else:
        paths = tracked_paths(root)
    findings = check_tree(root, paths)
    for finding in findings:
        print(finding)
    print(
        f"Checked {len(paths)} candidate files; {len(findings)} findings. "
        "Historical commits were not scanned."
    )
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
