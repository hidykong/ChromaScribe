#!/usr/bin/env python3
"""Export checked working-tree versions of tracked files without Git history."""

import argparse
import shutil
from pathlib import Path

from check_public_tree import check_tree, tracked_paths


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "destination",
        type=Path,
        help="New directory; an existing directory is never overwritten.",
    )
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    paths = tracked_paths(root)
    findings = check_tree(root, paths)
    if findings:
        raise SystemExit("Candidate tree failed checks. Run scripts/check_public_tree.py first.")
    destination = args.destination.resolve()
    destination.mkdir(parents=True, exist_ok=False)
    for name in paths:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / name, target)
    print(f"Exported {len(paths)} files to {destination}, without Git history.")
    print(
        "This is a review artifact, not a publication. "
        "Credential rotation, licensing and asset permissions still require review."
    )


if __name__ == "__main__":
    main()
