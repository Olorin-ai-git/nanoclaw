"""Load, validate, and atomically save .harness/harness.json (schema 1)."""

import json
from pathlib import Path

from cli import fileio
from cli.errors import HarnessError

CONFIG_REL = ".harness/harness.json"
SCHEMA_VERSION = 1


def _fail(path: Path, reason: str) -> None:
    raise HarnessError(f"{path}: {reason}", 1)


def _validate(path: Path, data: dict) -> None:
    project = data.get("project")
    if not isinstance(project, str) or not project.strip():
        _fail(path, '"project" must be a non-empty string')
    context_files = data.get("context_files")
    if not isinstance(context_files, list) or not all(
        isinstance(entry, str) for entry in context_files
    ):
        _fail(path, '"context_files" must be a list of strings')
    review = data.get("review")
    if not isinstance(review, dict) or "model" not in review:
        _fail(path, '"review" must be an object with a "model" key')
    if review["model"] is not None and not isinstance(review["model"], str):
        _fail(path, '"review.model" must be a string or null')
    installed_at = data.get("installed_at")
    if not isinstance(installed_at, str) or not installed_at.strip():
        _fail(path, '"installed_at" must be a non-empty string')


def load(root: Path) -> dict:
    """Read and validate the project's harness.json; every failure is actionable."""
    path = root / CONFIG_REL
    if not path.is_file():
        raise HarnessError(f"{path} not found — run `harness init` first", 1)
    try:
        data = json.loads(fileio.read_text(path, "harness.json"))
    except json.JSONDecodeError as exc:
        raise HarnessError(f"{path} is not valid JSON: {exc}", 1) from exc
    if not isinstance(data, dict):
        _fail(path, "top level must be a JSON object")
    if data.get("schema") != SCHEMA_VERSION:
        _fail(
            path,
            f'unknown schema {data.get("schema")!r} — this CLI understands '
            f"schema {SCHEMA_VERSION}; upgrade the harness or repair the file",
        )
    _validate(path, data)
    return data


def save(root: Path, data: dict) -> None:
    """Write harness.json atomically."""
    path = root / CONFIG_REL
    fileio.write_text(
        path, json.dumps(data, indent=2, sort_keys=True) + "\n", "harness.json",
        inside=root,
    )
