"""harness init — transactional install of the scaffold into a git project."""

import datetime
import json
import os
import shutil
from pathlib import Path

from cli import config, fileio, ignores, manifest, units
from cli.context import append_context_block, context_placement
from cli.errors import HarnessError, emit
from cli.gitcmd import check_canonical_settled, head_commit
from cli.paths import find_git_root, own_home, resolve_canonical
from cli.recovery import fresh_partial, move_aside, restore
from cli.render import render
from cli.smoke import smoke_staged_cli

HARNESS_REL = ".harness"
STAGING_REL = ".harness.staging"
VENDORED_DIRS = [".harness/cli", ".harness/bin"]

_VERBATIM = ("PROCESS.md", "SELF-IMPROVE.md", "LEARNINGS.md", "STATE.md")

_TEXT_UNITS = [
    {"id": "process-core", "type": "section", "path": ".harness/PROCESS.md",
     "marker": "harness:core", "template": "templates/PROCESS.md"},
    {"id": "selfimprove-core", "type": "section", "path": ".harness/SELF-IMPROVE.md",
     "marker": "harness:core", "template": "templates/SELF-IMPROVE.md"},
    {"id": "learnings-durable", "type": "section", "path": ".harness/LEARNINGS.md",
     "marker": "harness:durable", "template": "templates/LEARNINGS.md"},
    {"id": "agent-reviewer", "type": "file", "path": ".claude/agents/harness-reviewer.md",
     "marker": None, "template": "templates/agents/harness-reviewer.md"},
    {"id": "agent-auditor", "type": "file", "path": ".claude/agents/harness-auditor.md",
     "marker": None, "template": "templates/agents/harness-auditor.md"},
]


def _check_canonical_complete(canonical: Path) -> None:
    missing = [
        rel for rel in (
            *(f"templates/{name}" for name in _VERBATIM),
            "templates/EVALS.md", "cli/__main__.py", "bin/harness",
            *(u["template"] for u in _TEXT_UNITS),
            "templates/context/harness-context.md",
            "templates/context/harness-pointer.md",
        )
        if not (canonical / rel).is_file()
    ]
    if missing:
        raise HarnessError(
            f"canonical home {canonical} is incomplete — missing: "
            f"{', '.join(sorted(set(missing)))}",
            1,
        )


def _stage(root: Path, canonical: Path, project: str) -> Path:
    staging = root / STAGING_REL
    # Shadow the project root, so every record helper below writes through its
    # normal root-relative path before promotion.
    work = staging / HARNESS_REL
    work.mkdir(parents=True)
    for name in _VERBATIM:
        shutil.copy2(canonical / "templates" / name, work / name)
    evals = fileio.read_text(canonical / "templates" / "EVALS.md", "EVALS template")
    fileio.write_text(work / "EVALS.md", render(evals, {"PROJECT": project}),
                      "EVALS.md", inside=staging)
    for sub in ("cli", "bin"):
        shutil.copytree(
            canonical / sub, work / sub,
            ignore=shutil.ignore_patterns("__pycache__", ".*"),
        )
    (work / "runs").mkdir()
    (work / "runs" / ".keep").write_text("", encoding="utf-8")
    (work / "baselines").mkdir()
    ignores.ensure_ignores(work, staging)
    return staging


def _install_agents(root: Path, canonical: Path, saved: list) -> None:
    # Two passes — validate every agent file, then write: a divergent file is
    # refused before any of them is touched. What a failure can still leave
    # behind is byte-equal-to-canonical content, which the next run converges
    # on. A matching file is skipped outright — writing it would replace an
    # operator's link for nothing, and is why `staged` holds no prior content.
    staged = []
    for unit in _TEXT_UNITS:
        if unit["type"] != "file":
            continue
        dest = root / unit["path"]
        content = fileio.read_text(canonical / unit["template"], "agent template")
        if dest.is_file():
            if fileio.read_text(dest, unit["path"]) == content:
                continue
            raise HarnessError(
                f"{unit['path']} exists with different content — move it aside "
                "or reconcile it, then re-run harness init",
                1,
            )
        staged.append((dest, content, unit["path"]))
    for dest, content, what in staged:
        saved.append((dest, None))
        fileio.write_text(dest, content, what, inside=root)


def run(args) -> int:
    root = find_git_root(Path(args.target))
    if (root / manifest.MANIFEST_REL).exists():
        manifest.load(root)
        emit(f"already installed at {root}")
        return 0
    canonical = resolve_canonical(
        args.canonical, os.environ, None, required=False
    ) or own_home()
    if canonical is None:
        raise HarnessError(
            "no canonical harness home — pass --canonical or set OLORIN_HARNESS_HOME",
            1,
        )
    _check_canonical_complete(canonical)
    check_canonical_settled(canonical)
    project = (args.project or root.name).strip()
    if not project:
        raise HarnessError("--project must not be blank", 1)

    harness_dir = root / HARNESS_REL
    if harness_dir.exists():
        if not fresh_partial(harness_dir):
            raise HarnessError(
                f"{harness_dir} exists without manifest.json but holds run "
                "journals or an active goal — init never touches those. Restore "
                ".harness/manifest.json from the project's git history instead, "
                "or move the directory aside yourself and re-run init",
                1,
            )
        moved = move_aside(harness_dir)
        emit(f"moved incomplete install (no journals, no active goal) aside to {moved}")
    staging = root / STAGING_REL
    if staging.exists():
        # Rescued before the try, so init's own rollback can never delete a
        # leftover tree that belongs to an earlier run.
        moved = move_aside(staging)
        emit(f"moved leftover staging from an interrupted init aside to {moved}")
    saved: list[tuple[Path, bytes | None]] = []
    try:
        # Staging is inside the try: its own steps are fallible too, and a
        # refusal must not leave a half-built tree in the project.
        _stage(root, canonical, project)
        smoke_staged_cli(staging / HARNESS_REL)
        # The rename below is the single irreversible promotion — every
        # fallible step before it lands in staging, or is undone by restore().
        _install_agents(root, canonical, saved)
        ctx_units = context_placement(root)
        for unit in ctx_units:
            host = root / unit["path"]
            saved.append((host, host.read_bytes() if host.is_file() else None))
            append_context_block(root, unit, canonical)
        all_units = [dict(u) for u in _TEXT_UNITS] + ctx_units
        for unit in all_units:
            manifest.write_baseline(
                staging, unit, units.canonical_unit_text(canonical, unit)
            )
        cli_unit = {"id": "cli", "type": "vendored", "path": HARNESS_REL,
                    "marker": None, "template": ""}
        hashes = manifest.vendored_hashes(staging, VENDORED_DIRS)
        manifest.write_baseline(staging, cli_unit, json.dumps(hashes, indent=2) + "\n")
        all_units.append(cli_unit)
        config.save(staging, {
            "schema": 1,
            "project": project,
            "context_files": [u["path"] for u in ctx_units],
            "review": {"model": None},
            "installed_at": datetime.datetime.now(datetime.UTC).date().isoformat(),
        })
        manifest.save(staging, {
            "schema": 1,
            "canonical": {"path": str(canonical), "commit": head_commit(canonical)},
            "units": all_units,
        })
    except (HarnessError, OSError):
        # Transactional means transactional, for every way this can fail: the
        # project's own files go back to exactly what init found, not merely
        # "nothing was promoted".
        restore(saved, root)
        shutil.rmtree(staging, ignore_errors=True)
        raise
    try:
        os.rename(staging / HARNESS_REL, harness_dir)
    except OSError as exc:
        restore(saved, root)
        shutil.rmtree(staging, ignore_errors=True)
        raise HarnessError(
            f"could not promote the staged install into {harness_dir}: "
            f"{exc.strerror} — nothing was installed", 1
        ) from exc
    shutil.rmtree(staging, ignore_errors=True)  # only the empty container remains
    emit(f"installed harness into {root} (project: {project}, canonical: {canonical})")
    for unit in ctx_units:
        emit(f"context block: {unit['path']}")
    return 0
