"""Manifest store and baseline content addressing for installed harness units."""

import hashlib
import json
from pathlib import Path

from cli import fileio
from cli.errors import HarnessError

MANIFEST_REL = ".harness/manifest.json"
BASELINES_REL = ".harness/baselines"
SCHEMA_VERSION = 1


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _atomic_write_text(root: Path, path: Path, text: str) -> None:
    # Bound to the install tree: a symlinked baselines/ directory would
    # otherwise put every baseline outside the project.
    fileio.write_text(path, text, path.name, inside=root)


def load(root: Path) -> dict | None:
    """Parsed manifest for the project at root, or None when not installed."""
    path = root / MANIFEST_REL
    if not path.exists():
        return None
    try:
        data = json.loads(fileio.read_text(path, "manifest.json"))
    except json.JSONDecodeError as exc:
        raise HarnessError(
            f"manifest.json is not valid JSON ({path}): {exc} — "
            "restore it from the project's git history",
            1,
        ) from exc
    schema = data.get("schema") if isinstance(data, dict) else None
    if schema != SCHEMA_VERSION:
        raise HarnessError(
            f"unsupported manifest schema {schema!r} in {path} — "
            f"this CLI understands schema {SCHEMA_VERSION}; update the vendored CLI",
            1,
        )
    _validate_shape(data, path)
    return data


def _bad(path: Path, what: str) -> HarnessError:
    return HarnessError(
        f"manifest.json is malformed ({path}): {what} — "
        "restore it from git history",
        1,
    )


def _validate_shape(data: dict, path: Path) -> None:
    canonical = data.get("canonical")
    if not isinstance(canonical, dict) or not isinstance(canonical.get("path"), str):
        raise _bad(path, "canonical must be an object with a string path")
    if "commit" in canonical and not isinstance(canonical["commit"], str):
        raise _bad(path, "canonical.commit must be a string when present")
    if not isinstance(data.get("units"), list):
        raise _bad(path, "units must be a list")
    for unit in data["units"]:
        if not isinstance(unit, dict):
            raise _bad(path, "every unit must be an object")
        if not isinstance(unit.get("id"), str) or not unit["id"]:
            raise _bad(path, "every unit needs a string id")
        if unit.get("type") not in ("file", "section", "vendored"):
            raise _bad(path, f"unit {unit['id']}: unknown type {unit.get('type')!r}")
        for key, base_name in (("path", "the repo"), ("template", "the canonical home")):
            if key == "template" and unit["type"] == "vendored":
                continue
            rel = unit.get(key)
            if not isinstance(rel, str) or not rel:
                raise _bad(path, f"unit {unit['id']}: {key} must be a string")
            if Path(rel).is_absolute() or ".." in Path(rel).parts:
                raise _bad(path, f"unit {unit['id']}: {key} {rel!r} escapes {base_name}")
            if key == "template" and not rel.startswith("templates/"):
                raise _bad(
                    path,
                    f"unit {unit['id']}: template {rel!r} sits outside templates/ "
                    "— promote could never commit it",
                )
        if unit["type"] == "section" and not isinstance(unit.get("marker"), str):
            raise _bad(path, f"unit {unit['id']}: section units need a marker")
        if len(Path(unit["id"]).parts) != 1 or unit["id"] in (".", ".."):
            raise _bad(path, f"unit id {unit['id']!r} is not a plain name")
    ids = [u["id"] for u in data["units"]]
    if len(ids) != len(set(ids)):
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        raise _bad(path, f"duplicate unit id(s): {', '.join(dupes)}")


def save(root: Path, data: dict) -> None:
    _atomic_write_text(
        root, root / MANIFEST_REL, json.dumps(data, indent=2) + "\n"
    )


def write_baseline(root: Path, unit: dict, content: str) -> None:
    """Store the pristine unit content and record its hash on the unit."""
    _atomic_write_text(root, root / BASELINES_REL / unit["id"], content)
    unit["sha256"] = sha256_text(content)


def read_baseline(root: Path, unit: dict) -> str:
    """Baseline content for a unit, verified against the hash recorded in the manifest."""
    path = root / BASELINES_REL / unit["id"]
    if not path.is_file():
        raise HarnessError(
            f"baseline for unit {unit['id']} is missing or not a regular file "
            f"({path}) — restore it from the project's git history, or, when "
            f"the unit's installed content is correct, re-baseline with: "
            f"harness resolve {unit['id']}",
            1,
        )
    content = fileio.read_text(path, f"baseline for unit {unit['id']}")
    if sha256_text(content) != unit.get("sha256"):
        raise HarnessError(
            f"baseline for unit {unit['id']} does not match its recorded hash "
            f"({path}) — restore .harness/ from git history, or, when the unit's "
            f"installed content is correct, re-baseline with: harness resolve {unit['id']}",
            1,
        )
    return content


def write_conflictbase(root: Path, unit: dict, content: str) -> None:
    """Record the canonical content a conflicted merge ran against, so
    resolve can re-baseline to what the operator actually reconciled with."""
    _atomic_write_text(
        root, root / BASELINES_REL / f"{unit['id']}.conflictbase", content)


def read_conflictbase(root: Path, unit: dict) -> str | None:
    path = root / BASELINES_REL / f"{unit['id']}.conflictbase"
    if not path.is_file():
        return None
    return fileio.read_text(path, f"conflict-time baseline for unit {unit['id']}")


def clear_conflictbase(root: Path, unit: dict) -> None:
    path = root / BASELINES_REL / f"{unit['id']}.conflictbase"
    if path.is_file():
        path.unlink()


def read_vendored_baseline(root: Path, unit: dict) -> dict:
    """The vendored unit's baseline hash map, refusing corrupt content cleanly."""
    content = read_baseline(root, unit)
    try:
        data = json.loads(content)
    except json.JSONDecodeError as exc:
        raise HarnessError(
            f"vendored baseline for unit {unit['id']} is not valid JSON — "
            "restore it from git history",
            1,
        ) from exc
    if not isinstance(data, dict):
        raise HarnessError(
            f"vendored baseline for unit {unit['id']} must be a JSON object — "
            "restore it from git history",
            1,
        )
    return data


def _is_vendored_content(path: Path) -> bool:
    """Bytecode caches and hidden files are run artifacts, not vendored content."""
    return not any(
        part == "__pycache__" or part.startswith(".") for part in path.parts
    )


def vendored_hashes(base: Path, rel_dirs: list[str]) -> dict[str, str]:
    """Sorted relpath-to-sha256 map over every content file under the given dirs.

    Exclusion applies to the path below each scanned dir, so a hidden install
    dir like .harness in the prefix never hides its own vendored content.
    """
    hashes: dict[str, str] = {}
    for rel in rel_dirs:
        top = base / rel
        if not top.is_dir():
            continue
        for path in top.rglob("*"):
            if path.is_file() and _is_vendored_content(path.relative_to(top)):
                try:
                    digest = hashlib.sha256(path.read_bytes()).hexdigest()
                except OSError as exc:
                    raise HarnessError(
                        f"vendored file could not be read ({path}): {exc.strerror}",
                        1,
                    ) from exc
                hashes[path.relative_to(base).as_posix()] = digest
    return dict(sorted(hashes.items()))
