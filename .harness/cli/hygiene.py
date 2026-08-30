"""The hygiene questions doctor asks about an install.

`ignores` owns the rules file and `links` owns the write policy; this module
owns what doctor asks them. Every entry point returns strings doctor prints,
never an exception, because doctor keeps going.

The git-ignore answers are warning-grade. The link answers are not: a managed
path whose links the write policy refuses is a broken install, and reporting
that as a warning would understate it. What the policy permits — a context host
edited through the operator's link, into the project — is not reported at all.
"""

from pathlib import Path

from cli import ignores, links, units
from cli.errors import HarnessError
from cli.gitcmd import run_git


def tracked_artifacts(root: Path, harness_dir: Path) -> list[str]:
    """Tracked paths under the install that THIS install's own rules cover.

    A .gitignore never untracks what git already knows, so artifacts
    committed before the rules existed stay tracked until the operator runs
    git rm --cached on them. git does the matching; `-v` makes it name the
    file AND the pattern that matched, and both have to be ours.

    Provenance alone is not enough. The rules file is deliberately
    operator-extendable, so a line they added lives in our file and would
    otherwise carry our authority — and telling someone to untrack
    .harness/PROCESS.md because they ignored *.md is worse than saying
    nothing at all. Only the rules this module ships can name an artifact.

    -z everywhere: paths with a newline, a tab or a quote arrive verbatim
    instead of C-quoted, so the parse cannot be fooled by a filename.
    """
    rel = harness_dir.relative_to(root).as_posix()
    listed = run_git(root, "ls-files", "-z", "--", rel)
    tracked = [p for p in listed.stdout.split("\0") if p]
    if not tracked:
        return []
    res = run_git(root, "check-ignore", "--no-index", "-v", "-z", "--stdin",
                  check=False, input_text="\0".join(tracked) + "\0")
    if res.returncode not in (0, 1):
        raise HarnessError(
            f"git check-ignore failed in {root}: {res.stderr.strip()}", 1)
    ours = f"{rel}/{ignores.GITIGNORE_NAME}"
    fields = res.stdout.split("\0")
    matched = []
    # -z -v emits four NUL-terminated fields per match: source, line, pattern, path.
    for index in range(0, len(fields) - 3, 4):
        source, _, pattern, path = fields[index:index + 4]
        if source == ours and pattern in ignores.IGNORE_RULES and path:
            matched.append(path)
    return matched


def link_problems(root: Path, mani: dict, required: tuple[str, ...]) -> list:
    """doctor's FAIL-grade link checks over every path the harness writes.

    Split the way the write policy splits, because a check that asks a
    different question than the write answers is wrong whichever way it errs.
    A context host may be edited through the operator's link, so it fails only
    when the link escapes the project; every other managed path refuses any
    link at all. `units` owns that discriminator, so init, update and doctor
    cannot drift apart about the same file.

    The vendored unit's path is the install directory rather than a file it
    writes, so it is asked about through `required` instead — which already
    names the two vendored entry points. The baselines directory and the files
    under it are asked about explicitly: they are written on every sync but
    named in no unit's path, and a directory link there is exactly the shape a
    leaf-only check misses.
    """
    managed = [u for u in mani["units"] if u["type"] != "vendored"]
    followable = [u["path"] for u in managed if units.follows_operator_link(u)]
    strict = [u["path"] for u in managed if not units.follows_operator_link(u)]
    strict += [f"{ignores.HARNESS_DIR_NAME}/baselines"] + [
        f"{ignores.HARNESS_DIR_NAME}/baselines/{u['id']}" for u in mani["units"]
    ]
    asked = set(strict) | set(followable)
    strict += [rel for rel in required if rel not in asked]
    return links.audit_problems(root, strict, followable)


def doctor_problems(root: Path) -> list[tuple[str, str | None]]:
    """The two git-hygiene checks doctor renders as warnings."""
    harness_dir = root / ignores.HARNESS_DIR_NAME
    missing = ignores.missing_rules(harness_dir)
    if missing is None:
        rules = (f"{harness_dir / ignores.GITIGNORE_NAME} cannot be read — "
                 "restore or delete it, then run harness update")
    elif missing:
        rules = (f"{ignores.HARNESS_DIR_NAME}/{ignores.GITIGNORE_NAME} lacks "
                 "harness rules — harness update adds them")
    else:
        rules = None
    problems = [("ignore rules", rules)]
    if missing is None or missing:
        # Nothing has been proven about the artifacts while the rules that
        # define them are missing or unreadable — saying "ok" would be a
        # verdict this check never reached.
        problems.append(("generated artifacts",
                         "not determined until the ignore rules are in place"))
        return problems
    try:
        tracked = tracked_artifacts(root, harness_dir)
        problems.append((
            "generated artifacts",
            "tracked despite ignore rules: " + ", ".join(tracked) +
            " — git rm --cached them so the rules take effect"
            if tracked else None,
        ))
    except HarnessError as err:
        problems.append(("generated artifacts", str(err)))
    return problems
