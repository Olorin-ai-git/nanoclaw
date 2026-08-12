"""Vendored-unit replacement: wholesale restore of .harness/cli and bin."""

import json
import os
import shutil
from pathlib import Path

from cli import links, manifest
from cli.commands_info import canonical_vendored
from cli.commands_init import VENDORED_DIRS
from cli.errors import HarnessError
from cli.ignores import VENDORSTAGE_NAME
from cli.smoke import smoke_staged_cli

STAGE_REL = f".harness/{VENDORSTAGE_NAME}"


def _clear_stale_stage(stage: Path, root: Path) -> None:
    """Remove a leftover staging path, refusing any symlink sitting at it.

    Check before mutating, in that order and no other. The harness never
    creates a symlink here — what a crashed update leaves behind is the real
    directory `stage.mkdir()` made — so a link at this name was placed by
    somebody, wherever it points, and removing it because the name reads like
    scratch is the same destruction of operator plumbing this policy exists to
    refuse. Refusing costs the self-heal nothing, because the residue it has
    to clear is a directory. Both refusals are here rather than one: the
    escape check runs first so a link out of the project is named as the
    boundary violation it is, and an in-project one is refused after it with
    the remedy that fits scratch the harness owns.
    """
    links.refuse_escaping(stage, root, "the vendored staging path")
    if stage.is_symlink():
        raise HarnessError(
            f"the vendored staging path {stage} is a symlink "
            f"(-> {links.target_of(stage)}) — delete the link; the harness "
            "stages the replacement CLI in a real directory of its own there",
            1,
        )
    try:
        if stage.is_dir():
            shutil.rmtree(stage)
        elif stage.exists():
            stage.unlink()
    except OSError as exc:
        raise HarnessError(
            f"cannot clear the leftover staging path {stage}: {exc.strerror} — "
            "remove it, then re-run harness update",
            1,
        ) from exc


def update_vendored(root: Path, canonical: Path, unit: dict) -> str | None:
    """Restore the vendored CLI whenever it differs from canonical — staleness
    and local drift alike. The full replacement is staged and smoke-tested
    first; copy-then-swap keeps the no-CLI crash window small.
    Returns what happened: "replaced", "rebaselined", or None (current)."""
    try:
        baseline = manifest.read_vendored_baseline(root, unit)
    except HarnessError:
        # A corrupt or hash-mismatched vendored baseline (crash window between
        # the baseline write and the manifest save) is repaired here — resolve
        # deliberately refuses vendored units, so this is the recovery path.
        baseline = None
    installed = manifest.vendored_hashes(root, VENDORED_DIRS)
    # This unit is the one place the harness mutates whole directories, and it
    # does so with shutil/os rather than through fileio, so the policy has to be
    # applied here by hand. refuse_replacing below sees a linked leaf; only
    # refuse_escaping resolves the WHOLE path, which is what catches a
    # symlinked `.harness` putting every path below it outside the project.
    # The staging path is guarded first because clearing a leftover stage is
    # the earliest thing this function deletes.
    _clear_stale_stage(root / STAGE_REL, root)
    if canonical_vendored(canonical) == installed:
        if installed != baseline:
            # Installed content already matches canonical but the baseline is
            # stale (crash window after a swap): repair the record.
            manifest.write_baseline(
                root, unit, json.dumps(installed, indent=2) + "\n"
            )
            return "rebaselined"
        return None
    # Named before any work is staged. shutil.rmtree below refuses a symlink
    # on its own, but reports it as "vendored CLI replacement failed", which
    # tells the operator nothing about the link they placed.
    for sub in ("cli", "bin"):
        links.refuse_replacing(root / ".harness" / sub, f"vendored .harness/{sub}")
        links.refuse_escaping(root / ".harness" / sub, root, f"vendored .harness/{sub}")
    stage = root / STAGE_REL
    try:
        stage.mkdir()
        for sub in ("cli", "bin"):
            shutil.copytree(
                canonical / sub, stage / sub,
                ignore=shutil.ignore_patterns("__pycache__", ".*"),
            )
        try:
            smoke_staged_cli(stage)
        except HarnessError:
            shutil.rmtree(stage, ignore_errors=True)
            raise
        for sub in ("cli", "bin"):
            dest = root / ".harness" / sub
            if dest.exists():
                shutil.rmtree(dest)
            os.rename(stage / sub, dest)
        shutil.rmtree(stage, ignore_errors=True)
    except OSError as exc:
        raise HarnessError(
            f"vendored CLI replacement failed ({exc}) — restore .harness/cli "
            "and .harness/bin by running the canonical checkout's own "
            "bin/harness update against this project",
            1,
        ) from exc
    hashes = manifest.vendored_hashes(root, VENDORED_DIRS)
    manifest.write_baseline(root, unit, json.dumps(hashes, indent=2) + "\n")
    return "replaced"
