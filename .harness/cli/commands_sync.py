"""harness update and resolve — the pull side of the symmetric sync."""

import os
from pathlib import Path

from cli import fileio, ignores, manifest, merge, units
from cli.commands_info import load_install
from cli.errors import HarnessError, emit
from cli.gitcmd import check_canonical_settled, head_commit
from cli.learnings import normalize_learnings
from cli.paths import resolve_canonical
from cli.vendored import update_vendored


def resolve_hard(args, mani) -> Path:
    return resolve_canonical(
        getattr(args, "canonical", None), os.environ,
        mani["canonical"]["path"], required=True,
    )


def unit_by_id(mani: dict, unit_id: str) -> dict:
    for unit in mani["units"]:
        if unit["id"] == unit_id:
            return unit
    known = ", ".join(u["id"] for u in mani["units"])
    raise HarnessError(f"no unit named {unit_id!r} — installed units: {known}", 1)


def normalize_learnings_file(root: Path, unit: dict) -> None:
    host = root / unit["path"]
    what = f"unit {unit['id']} host file {unit['path']}"
    text, removed = normalize_learnings(fileio.read_text(host, what))
    if removed:
        fileio.write_text(host, text, what, inside=root)
        emit(f"normalized {unit['path']}: removed {', '.join(removed)}")


def normalize_quietly(root: Path, unit: dict) -> None:
    """Normalize the learnings host file without changing the verdict of the
    operation that just ran: it also reads the project-owned section, which
    no unit owns, and doctor is what FAILs a broken one."""
    try:
        normalize_learnings_file(root, unit)
    except HarnessError as err:
        emit(f"note: {unit['path']} could not be normalized: {err} — "
             "harness doctor reports what is wrong with it")


def _update_one(root, canonical, unit, mani, conflicted) -> None:
    if unit["type"] == "vendored":
        outcome = update_vendored(root, canonical, unit)
        if outcome == "replaced":
            manifest.save(root, mani)
            emit(f"updated {unit['id']} (vendored, replaced wholesale)")
        elif outcome == "rebaselined":
            manifest.save(root, mani)
            emit(f"re-baselined {unit['id']} (installed content already current)")
        return
    canon_text = units.canonical_unit_text(canonical, unit)
    base_text = manifest.read_baseline(root, unit)
    # Read the project side before the skip rule so a damaged unit (missing
    # host, broken markers) surfaces even when canonical has not moved.
    project_text = units.read_unit(root, unit)
    if merge.has_conflict_markers(project_text):
        conflicted.append(unit["id"])
        emit(f"refused {unit['id']}: unresolved conflict markers in "
             f"{unit['path']} — resolve them, then run: harness resolve {unit['id']}")
        return
    if canon_text == base_text:
        # A prior sync may have left normalization undone; retry it even when
        # canonical has not moved. Nothing synced here, so a failure is not
        # this unit's failure: normalization also reads the project-owned
        # section, which no unit owns and operators edit freely. Report it and
        # let doctor name the damage rather than booking the unit as damaged.
        if unit["id"] == "learnings-durable":
            normalize_quietly(root, unit)
        return
    if project_text == base_text:
        units.write_unit(root, unit, canon_text)
        manifest.write_baseline(root, unit, canon_text)
        manifest.clear_conflictbase(root, unit)
        manifest.save(root, mani)
        emit(f"updated {unit['id']}")
    else:
        merged, conflict = merge.merge3(
            base_text, project_text, canon_text,
            (unit["path"], "baseline", "canonical"), root,
        )
        units.write_unit(root, unit, merged)
        if conflict:
            conflicted.append(unit["id"])
            # Record the canonical content this conflict merged against:
            # resolve re-baselines to it, not to whatever canonical says
            # by the time the operator finishes resolving.
            manifest.write_conflictbase(root, unit, canon_text)
            emit(f"conflict in {unit['id']} ({unit['path']}) — resolve the "
                 f"markers, then run: harness resolve {unit['id']}")
            return
        # Baseline is always pristine canonical content, never merged text:
        # the surviving local edit stays visible as drift for promote.
        manifest.write_baseline(root, unit, canon_text)
        manifest.clear_conflictbase(root, unit)
        manifest.save(root, mani)
        emit(f"merged {unit['id']}")
    if unit["id"] == "learnings-durable":
        normalize_quietly(root, unit)


def update(args) -> int:
    root, mani = load_install(args.target)
    # Installs from before the ignore rules existed heal here, additively —
    # before the canonical is resolved, because git hygiene is local and
    # doctor tells operators this command repairs it whether or not the
    # canonical home can be reached.
    if ignores.ensure_ignores(root / ignores.HARNESS_DIR_NAME, root):
        emit("ignore rules added: .harness/.gitignore")
    canonical = resolve_hard(args, mani)
    check_canonical_settled(canonical)
    conflicted: list[str] = []
    broken: list[str] = []
    for unit in mani["units"]:
        try:
            _update_one(root, canonical, unit, mani, conflicted)
        except HarnessError as err:
            # One damaged unit must not block the rest of the sync.
            broken.append(unit["id"])
            emit(f"skipped {unit['id']}: {err}")
    if conflicted or broken:
        if conflicted:
            emit(f"{len(conflicted)} unit(s) left conflicted: {', '.join(conflicted)}")
        if broken:
            emit(f"{len(broken)} unit(s) skipped as damaged: {', '.join(broken)}")
        # A partial sync must not book the canonical commit as synchronized —
        # the recorded commit stays at the last FULLY synced state. Saving
        # after the accounting keeps a failing save from swallowing it.
        manifest.save(root, mani)
        return 1
    # Refresh only the synced commit; the recorded canonical path is install
    # data written by init — a one-off --canonical override must not silently
    # become permanent.
    mani["canonical"]["commit"] = head_commit(canonical)
    manifest.save(root, mani)
    emit("update complete")
    return 0


def resolve(args) -> int:
    root, mani = load_install(args.target)
    canonical = resolve_hard(args, mani)
    unit = unit_by_id(mani, args.unit)
    if unit["type"] == "vendored":
        raise HarnessError(
            "the vendored CLI is replaced by harness update, never resolved", 1
        )
    project_text = units.read_unit(root, unit)
    if merge.has_conflict_markers(project_text):
        raise HarnessError(
            f"{unit['path']} still contains conflict markers — finish resolving "
            "them first",
            1,
        )
    try:
        baseline = manifest.read_baseline(root, unit)
    except HarnessError:
        # A missing or corrupt baseline is exactly what resolve repairs —
        # it is about to be overwritten, so its current state cannot block.
        baseline = None
    conflictbase = manifest.read_conflictbase(root, unit)
    if conflictbase is None and baseline is not None and project_text == baseline:
        raise HarnessError(
            f"nothing to resolve for {unit['id']} — the unit matches its baseline; "
            "run harness update to pull canonical changes instead (resolve is only "
            "for after a conflicted merge was fixed by hand)",
            1,
        )
    if conflictbase is not None:
        # The canonical content the conflicted merge actually ran against.
        # Re-reading canonical here instead would let a commit that landed
        # mid-resolution advance the baseline past the project — the silent
        # revert, through yet another door.
        new_baseline = conflictbase
        source = "the canonical content the conflicted update merged against"
    else:
        check_canonical_settled(canonical)
        new_baseline = units.canonical_unit_text(canonical, unit)
        source = "current canonical content"
    manifest.write_baseline(root, unit, new_baseline)
    manifest.clear_conflictbase(root, unit)
    manifest.save(root, mani)
    emit(f"re-baselined {unit['id']} to {source}")
    if project_text != new_baseline:
        emit(
            f"{unit['id']} still differs from that baseline — {unit['path']} keeps its "
            "local content and stays reported as drift; push it up with harness "
            "promote, or take canonical's version with harness update"
        )
    return 0
