"""Git-ignore coverage for generated and transient harness artifacts.

The install directory is committed content (process files, manifest,
baselines, run journals, vendored CLI), but the harness also writes artifacts
that must never reach git: the rendered dashboard, bytecode caches, the
staging directories inside the install, and fileio's atomic-write siblings.
A .gitignore inside .harness/ keeps that coverage self-contained — the
project's root .gitignore is never edited, which is also why the two things
that live OUTSIDE the install are covered differently: a rescue copy carries
its own blanket ignore (self_ignore), and a live .harness.staging during a
crashed init stays visible, an accepted residual rather than a reason to
write into a file the project owns. Artifact names live here, next to the rules built from
them, so a writer and its rule can never drift apart; fileio's staging
suffix is the one exception, owned there because this module does its IO
through fileio.
"""

from pathlib import Path

from cli import fileio
from cli.errors import HarnessError

HARNESS_DIR_NAME = ".harness"
GITIGNORE_NAME = ".gitignore"
DASHBOARD_NAME = "dashboard.html"
VENDORSTAGE_NAME = "vendorstage"
MERGEWORK_NAME = "mergework"

_HEADER = ("# Harness-generated transients — rules maintained additively "
           "by harness init/update.")
# Anchored where an artifact has one fixed home; suffix rules stay unanchored
# because bytecode and atomic-write siblings appear at any depth.
IGNORE_RULES = (
    f"/{DASHBOARD_NAME}",
    f"/{VENDORSTAGE_NAME}/",
    f"/{MERGEWORK_NAME}/",
    "__pycache__/",
    "*.pyc",
    f"*{fileio.ATOMIC_SUFFIX}",
)
_SELF_IGNORE = "# Harness rescue copy — inspect or delete; never commit.\n*\n"


def _rules_text(path: Path) -> str | None:
    """Current rules file content; None when it cannot be read.

    Ignore hygiene is a warning-grade concern, so a rules file that cannot
    be read degrades the checks that consult it — it never aborts a command
    that only wanted to keep the install tidy. Anything occupying the path
    that is not a regular file reads as unknowable rather than as absent:
    calling it absent would send the writer at a directory.
    """
    if path.is_symlink():
        # Deliberate operator plumbing pointing who-knows-where: reading
        # through it would inline foreign content into the install, and
        # writing would replace the link they put there on purpose.
        return None
    if not path.exists():
        return ""
    if not path.is_file():
        return None
    try:
        return fileio.read_text(path, GITIGNORE_NAME)
    except HarnessError:
        return None


def _write_rules(path: Path, text: str, inside: Path) -> bool:
    """Write the rules file; False when it could not be written.

    Same contract in the other direction: a read-only parent or an occupied
    path leaves the install exactly as it was, and doctor — the command that
    diagnoses — reports the rules are still missing."""
    try:
        fileio.write_text(path, text, GITIGNORE_NAME, inside=inside)
        return True
    except HarnessError:
        return False


def missing_rules(harness_dir: Path) -> list[str] | None:
    """Rules .harness/.gitignore does not carry yet, in install order.

    None when the file exists but cannot be read: nothing can be concluded
    about its contents, which is not the same as "no rules are missing".
    """
    existing = _rules_text(harness_dir / GITIGNORE_NAME)
    if existing is None:
        return None
    have = {line.strip() for line in existing.splitlines()}
    return [rule for rule in IGNORE_RULES if rule not in have]


def ensure_ignores(harness_dir: Path, inside: Path) -> bool:
    """Create or additively extend .harness/.gitignore; True when changed.

    Lines an operator added stay byte-for-byte intact — only absent harness
    rules are appended. An unreadable rules file is left exactly as it is:
    rewriting content we cannot read would destroy it."""
    path = harness_dir / GITIGNORE_NAME
    existing = _rules_text(path)
    if existing is None:
        return False
    missing = [rule for rule in IGNORE_RULES
               if rule not in {line.strip() for line in existing.splitlines()}]
    if not missing:
        return False
    if not existing:
        existing = _HEADER + "\n"
    elif not existing.endswith("\n"):
        existing += "\n"
    return _write_rules(path, existing + "\n".join(missing) + "\n", inside)


def self_ignore(directory: Path) -> None:
    """Make a rescue directory invisible to git wholesale.

    Abandoned copies exist for the operator to inspect, never for a stray
    git add -A to commit. A rescue-renamed regular file has no inside to
    cover, and a symlink is never followed: writing through one would land
    harness content in a directory outside the project altogether, over
    whatever file already sat there. Existing content is extended, not
    replaced, for the same reason ensure_ignores appends."""
    if directory.is_symlink() or not directory.is_dir():
        return
    path = directory / GITIGNORE_NAME
    existing = _rules_text(path)
    if existing is None or any(
        line.strip() == "*" for line in existing.splitlines()
    ):
        return
    if existing and not existing.endswith("\n"):
        existing += "\n"
    # The rescue copy sits beside the install, so the tree it may not
    # escape is the directory holding it.
    _write_rules(path, existing + _SELF_IGNORE, directory.parent)
