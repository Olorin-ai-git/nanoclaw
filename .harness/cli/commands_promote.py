"""harness promote — the push side of the symmetric sync."""

from pathlib import Path

from cli import config, fileio, manifest, merge, units
from cli.commands_info import load_install
from cli.commands_sync import normalize_quietly, resolve_hard
from cli.errors import HarnessError, emit
from cli.gitcmd import head_commit, real_dirt, run_git
from cli.learnings import collapse_trailing_blanks, dedupe_section


def _git(canonical: Path, *argv: str, check: bool = True):
    return run_git(canonical, *argv, check=check)


def _check_canonical_clean(canonical: Path) -> None:
    inside = _git(canonical, "rev-parse", "--is-inside-work-tree", check=False)
    if inside.returncode != 0 or inside.stdout.strip() != "true":
        raise HarnessError(
            f"canonical home {canonical} is not a git checkout — promote refuses "
            "to write into an unversioned copy",
            1,
        )
    dirty = _git(canonical, "status", "--porcelain", "--", "templates/").stdout
    if real_dirt(dirty):
        raise HarnessError(
            f"canonical templates/ tree is dirty in {canonical} — commit or clean "
            "it, then re-run promote",
            1,
        )


def _write_canonical_unit(canonical: Path, unit: dict, content: str) -> None:
    template = canonical / unit["template"]
    what = f"canonical template {unit['template']}"
    if unit["type"] == "section":
        text = fileio.read_text(template, what)
        fileio.write_text(
            template, units.splice_section(text, unit["marker"], content), what,
            inside=canonical,
        )
    else:
        fileio.write_text(template, content, what, inside=canonical)


def promote(args) -> int:
    root, mani = load_install(args.target)
    canonical = resolve_hard(args, mani)
    _check_canonical_clean(canonical)
    project_name = config.load(root)["project"]

    promoted: list[tuple[dict, str]] = []
    conflicted: list[str] = []
    broken: list[str] = []
    for unit in mani["units"]:
        if unit["type"] == "vendored":
            continue
        try:
            base_text = manifest.read_baseline(root, unit)
            project_text = units.read_unit(root, unit)
            if project_text == base_text:
                continue
            if merge.has_conflict_markers(project_text):
                conflicted.append(unit["id"])
                emit(f"refused {unit['id']}: unresolved conflict markers in "
                     f"{unit['path']} — resolve them, then run: "
                     f"harness resolve {unit['id']}")
                continue
            canon_text = units.canonical_unit_text(canonical, unit)
            merged, conflict = merge.merge3(
                base_text, canon_text, project_text,
                ("canonical", "baseline", project_name), root,
            )
            if conflict:
                conflicted.append(unit["id"])
                emit(f"conflict promoting {unit['id']} — canonical moved since "
                     "your baseline; run harness update, fix the conflict, run "
                     f"harness resolve {unit['id']}, then promote again")
                continue
            if unit["id"] == "learnings-durable":
                merged = dedupe_section(merged)
            if unit["type"] == "section":
                merged = collapse_trailing_blanks(merged)
            _write_canonical_unit(canonical, unit, merged)
            promoted.append((unit, merged))
            emit(f"promoting {unit['id']}")
        except HarnessError as err:
            # One damaged unit must not abort the promote of the healthy ones.
            broken.append(unit["id"])
            emit(f"skipped {unit['id']}: {err}")

    if not promoted:
        if conflicted or broken:
            emit(f"{len(conflicted) + len(broken)} unit(s) not promoted: "
                 f"{', '.join(conflicted + broken)}")
            return 1
        emit("nothing to promote")
        return 0

    # Name the exact templates this promote wrote, never a directory sweep:
    # a dotted template must still count as a change, and junk sitting beside
    # them must never make the commit fire on nothing.
    written = sorted({unit["template"] for unit, _ in promoted})
    changed = _git(canonical, "status", "--porcelain", "--", *written).stdout.strip()
    if changed:
        # Pathspec-limited commit: never sweeps whatever else sits in the
        # canonical repo's index (the monorepo self-install case).
        _git(canonical, "commit", "-m", f"harness: promote from {project_name}",
             "--", *written)
        branch = _git(canonical, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
        sha = _git(canonical, "rev-parse", "--short", "HEAD").stdout.strip()
        emit(f"promoted {len(promoted)} unit(s) to canonical {branch} @ {sha}")
    else:
        emit("canonical already holds these changes — re-baselining only")

    stranded: list[str] = []
    for unit, merged in promoted:
        # Restore the merge invariant: project == canonical == baseline, all
        # from the SAME merged text this promote produced. Re-reading canonical
        # here instead would capture any commit that landed in the
        # commit-to-re-baseline window and advance the baseline past the
        # project — the silent-revert defect, through a second door.
        try:
            units.write_unit(root, unit, merged)
            manifest.write_baseline(root, unit, merged)
            # The recorded conflict is settled by this re-baseline; leaving it
            # would let a subsequent resolve re-baseline to conflict-time content.
            manifest.clear_conflictbase(root, unit)
            manifest.save(root, mani)
        except HarnessError as err:
            stranded.append(unit["id"])
            emit(f"re-baseline of {unit['id']} failed after the canonical commit "
                 f"landed: {err} — canonical already holds the content; clear "
                 "that cause, then re-run promote to finish the bookkeeping")
    learn = next((u for u in mani["units"] if u["id"] == "learnings-durable"), None)
    if learn is not None:
        # The canonical commit and every re-baseline are already booked, so a
        # hygiene failure reports itself without changing what the promote
        # did (same rule as the update side).
        normalize_quietly(root, learn)
    if conflicted or broken or stranded:
        if conflicted or broken:
            emit(f"{len(conflicted) + len(broken)} unit(s) not promoted: "
                 f"{', '.join(conflicted + broken)}")
        # A partial promote must not book the canonical commit as
        # synchronized; the accounting above is printed first so a failing
        # save cannot swallow it.
        manifest.save(root, mani)
        return 1
    # Refresh only the synced commit — a one-off --canonical override must not
    # silently become the permanently recorded canonical (same rule as update).
    mani["canonical"]["commit"] = head_commit(canonical)
    manifest.save(root, mani)
    return 0
