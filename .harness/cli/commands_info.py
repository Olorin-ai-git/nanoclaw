"""harness status and doctor — install inspection."""

import os
from pathlib import Path

from cli import config, fileio, hygiene, manifest, merge, units
from cli.commands_init import VENDORED_DIRS
from cli.errors import HarnessError, emit
from cli.paths import find_git_root, resolve_canonical

REQUIRED_FILES = (
    ".harness/PROCESS.md", ".harness/SELF-IMPROVE.md", ".harness/LEARNINGS.md",
    ".harness/EVALS.md", ".harness/STATE.md", ".harness/harness.json",
    ".harness/manifest.json", ".harness/bin/harness", ".harness/cli/__main__.py",
)


def load_install(target) -> tuple[Path, dict]:
    root = find_git_root(Path(target))
    mani = manifest.load(root)
    if mani is None:
        raise HarnessError(f"no harness install found at {root} — run harness init", 1)
    return root, mani


def resolve_soft(args, mani) -> Path | None:
    return resolve_canonical(
        getattr(args, "canonical", None), os.environ,
        mani["canonical"]["path"], required=False,
    )


def canonical_vendored(canonical: Path) -> dict[str, str]:
    """Canonical cli/bin hashes re-keyed to their installed locations."""
    raw = manifest.vendored_hashes(canonical, ["cli", "bin"])
    return {f".harness/{key}": value for key, value in raw.items()}


def _active_state_line(root: Path) -> str:
    state = root / ".harness/STATE.md"
    if not state.is_file():
        return "(.harness/STATE.md is missing — doctor will report it)"
    try:
        text = fileio.read_text(state, "STATE.md")
    except HarnessError as err:
        return f"(STATE.md unreadable — {err})"
    for line in text.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            return stripped
    return "(STATE.md holds no state line)"


def unit_flags(root: Path, canonical: Path | None, unit: dict) -> tuple[bool, bool]:
    """(stale, drift) for one unit — canonical vs baseline, project vs baseline."""
    if unit["type"] == "vendored":
        baseline = manifest.read_vendored_baseline(root, unit)
        drift = manifest.vendored_hashes(root, VENDORED_DIRS) != baseline
        stale = canonical is not None and canonical_vendored(canonical) != baseline
        return stale, drift
    baseline = manifest.read_baseline(root, unit)
    drift = units.read_unit(root, unit) != baseline
    stale = canonical is not None and units.canonical_unit_text(canonical, unit) != baseline
    return stale, drift


def state_word(stale: bool, drift: bool) -> str:
    """One-word unit state — the same wording status prints and the dashboard chips render."""
    marks = [word for word, on in (("stale", stale), ("drift", drift)) if on]
    return "+".join(marks) if marks else "current"


def status(args) -> int:
    root, mani = load_install(args.target)
    canonical = resolve_soft(args, mani)
    emit(f"state: {_active_state_line(root)}")
    if canonical is None:
        emit("canonical unreachable — skipping staleness check")
    broken = 0
    for unit in mani["units"]:
        try:
            stale, drift = unit_flags(root, canonical, unit)
        except HarnessError as err:
            broken += 1
            emit(f"{unit['id']}: BROKEN — {err}")
            continue
        emit(f"{unit['id']}: {state_word(stale, drift)}")
    return 1 if broken else 0


def doctor(args) -> int:
    """Integrity checks that keep going: a corrupt manifest or config is
    reported as its own failed check, never a reason doctor cannot run."""
    root = find_git_root(Path(args.target))
    failures = 0
    warnings = 0

    def check(name: str, problem: str | None, *, warn: bool = False) -> None:
        nonlocal failures, warnings
        if problem is None:
            emit(f"ok {name}")
        elif warn:
            warnings += 1
            emit(f"warn {name}: {problem}")
        else:
            failures += 1
            emit(f"FAIL {name}: {problem}")

    try:
        mani = manifest.load(root)
    except HarnessError as err:
        mani = None
        check("manifest.json", str(err))
    if mani is None and not (root / manifest.MANIFEST_REL).exists():
        raise HarnessError(f"no harness install found at {root} — run harness init", 1)

    missing = [rel for rel in REQUIRED_FILES if not (root / rel).is_file()]
    check("required files", ", ".join(missing) if missing else None)
    try:
        config.load(root)
        check("harness.json", None)
    except HarnessError as err:
        check("harness.json", str(err))
    state = root / ".harness/STATE.md"
    if state.is_file():
        try:
            fileio.read_text(state, "STATE.md")
            check("state file", None)
        except HarnessError as err:
            check("state file", str(err))
    # Structural project-owned sections: no unit owns them, but a lost pair
    # breaks the files the loop and the sync both depend on.
    for rel in (".harness/PROCESS.md", ".harness/SELF-IMPROVE.md", ".harness/LEARNINGS.md"):
        if not (root / rel).is_file():
            continue
        try:
            text = fileio.read_text(root / rel, rel)
        except HarnessError:
            continue
        check(f"project section in {rel}", units.project_section_problem(text))
    for name, problem in hygiene.doctor_problems(root):
        check(name, problem, warn=True)
    if mani is None:
        emit(f"{failures} check(s) failed")
        return 1
    for name, problem in hygiene.link_problems(root, mani, REQUIRED_FILES):
        check(name, problem)
    for unit in mani["units"]:
        name = f"unit {unit['id']}"
        try:
            if unit["type"] == "section":
                host_path = root / unit["path"]
                if not host_path.is_file():
                    check(name, f"missing host file {unit['path']}")
                    continue
                host = fileio.read_text(host_path, f"unit {unit['id']} host file")
                begins = host.count(f"<!-- {unit['marker']}:begin -->")
                ends = host.count(f"<!-- {unit['marker']}:end -->")
                if begins != 1 or ends != 1:
                    check(name, f"expected one {unit['marker']} pair, found "
                          f"{begins} begin and {ends} end token(s)")
                    continue
            if unit["type"] == "vendored":
                current = manifest.vendored_hashes(root, VENDORED_DIRS)
                drifted = current != manifest.read_vendored_baseline(root, unit)
                check(name, "vendored CLI differs from baseline — harness update "
                      "will restore it; local edits there do not survive"
                      if drifted else None, warn=True)
                continue
            manifest.read_baseline(root, unit)
            text = units.read_unit(root, unit)
            if merge.has_conflict_markers(text):
                check(name, "holds unresolved merge conflict markers — resolve, "
                      f"then run harness resolve {unit['id']}")
                continue
            check(name, None)
        except (HarnessError, OSError) as err:
            check(name, str(err))
    try:
        canonical = resolve_soft(args, mani)
        problem = (None if canonical is not None else
                   f"unreachable ({mani['canonical']['path']}) — "
                   "update and promote need it")
    except HarnessError as err:
        # An explicit --canonical/OLORIN_HARNESS_HOME that names the wrong
        # directory is a refusal everywhere else; here it is one more check,
        # because doctor owes a summary even when its last check fails.
        problem = str(err)
    check("canonical home", problem, warn=True)
    if failures:
        emit(f"{failures} check(s) failed")
        return 1
    # Warnings are not failures, but "all checks passed" over a screen of them
    # would be a summary the run does not support.
    emit("all checks passed" if not warnings else
         f"no checks failed; {warnings} warning(s) above need attention")
    return 0
