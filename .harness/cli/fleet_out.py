"""The fleet output directory: naming its pages, and clearing the dead ones.

Both concerns here are about the directory the site is written into rather than
about any project, and both are places a careless write escapes: a project name
becomes a filename, and pruning deletes. They live together so the containment
rules are read together.
"""

import hashlib
import json
import re
from pathlib import Path

from cli import fileio, links
from cli.errors import HarnessError

PROJECTS_DIR = "projects"
INDEX_NAME = "index.html"

# Stamped into every page this command generates. Corroboration, NOT proof:
# a marker is public text, so an operator who copies a generated page to keep
# it carries the marker with it, and treating the marker alone as a licence to
# delete would destroy exactly the file they meant to preserve.
GENERATED_MARKER = "<!-- harness-fleet:generated -->"
_MARKER_WINDOW = 4096

# The actual proof of ownership: a record, written by this command, of the
# pages it produced. Only a file named in the PREVIOUS record may be deleted,
# and then only if it still carries the marker. A dotfile so it is never served
# as a page and never mistaken for one.
LEDGER_NAME = ".harness-fleet.json"

_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


def slug(name: str, taken: set) -> str:
    """A filename-safe, collision-free stem for a project's page.

    Everything outside a conservative set becomes a dash, and leading dots and
    dashes are stripped: the result is joined to the output directory, so a
    name carrying a separator or `..` must not be able to steer the write.
    `fileio` refuses an escaping path as well — this is the first of the two
    checks, not the only one.

    Collisions get a numeric suffix rather than the second project silently
    overwriting the first one's page. Compared case-insensitively because the
    filesystem here is: two projects differing only by case would otherwise be
    two rows pointing at one file.
    """
    stem = _UNSAFE.sub("-", name).strip("-.") or "project"
    candidate, index = stem, 2
    while candidate.lower() in taken:
        candidate = f"{stem}-{index}"
        index += 1
    taken.add(candidate.lower())
    return candidate


def is_generated(path: Path) -> bool:
    """Whether this file carries the marker only this command writes.

    Unreadable counts as NOT generated: the failure mode of guessing wrong is
    deleting somebody's file, so the doubt resolves toward keeping it.
    """
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            return GENERATED_MARKER in handle.read(_MARKER_WINDOW)
    except OSError:
        return False


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def read_ledger(out: Path) -> dict:
    """name -> content digest, as the previous run recorded writing it.

    Unreadable or malformed means an empty record, and an empty record means
    delete nothing. That is the safe direction: a fleet that keeps a stale page
    is wrong, a fleet that deletes an operator's file is unrecoverable.
    """
    path = out / PROJECTS_DIR / LEDGER_NAME
    if path.is_symlink() or not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    pages = data.get("pages") if isinstance(data, dict) else None
    if not isinstance(pages, dict):
        return {}
    return {str(k): str(v) for k, v in pages.items()}


def write_ledger(out: Path, pages: dict, inside: Path) -> None:
    """Record what this run wrote, and its digest, so the next run can tell an
    untouched page of ours from one the operator has since made their own."""
    body = json.dumps({"pages": dict(sorted(pages.items()))}, indent=2) + "\n"
    fileio.write_text(out / PROJECTS_DIR / LEDGER_NAME, body,
                      "the fleet page ledger", inside=inside)


def prune_stale_pages(out: Path, kept: set) -> list:
    """Delete pages a PREVIOUS run of this command wrote and this one did not.

    Without this, a project that leaves the fleet keeps its page: the index
    stops linking it, but the file is still served, so an old link or a search
    result answers with a dead project's dashboard presented as current. Worse
    than a 404, because it looks fine.

    Four bounds, each earned by a way this went wrong:

    * **Only names in the previous ledger.** `--out` is a publish directory an
      operator may keep their own pages in. The first attempt bounded deletion
      by directory and extension, which destroyed their `team-notes.html`; the
      second added a marker, which a judge correctly refused as proof, because
      a marker is public text that travels with any copy of a generated page.
      What this command wrote is a fact only this command can know, so it
      writes it down.
    * **And byte-identical to what we wrote.** The ledger records each page's
      digest, so a page the operator has since edited — customised and kept
      under the same name — no longer matches and is left alone. Ownership is
      of specific bytes, not of a filename.
    * **And still carrying the marker.** Belt to the ledger's braces.
    * **Names compared case-insensitively.** On a case-insensitive filesystem,
      writing `alpha.html` over an existing `Alpha.html` keeps the OLD directory
      entry, so an exact-match `kept` test deletes the page this very run just
      wrote — leaving the index linking a 404 at exit 0.
    * **A symlink is skipped, not removed.** The harness creates none here, so
      one is the operator's, and deleting it is the destruction of their
      plumbing the write policy exists to refuse.
    """
    projects = out / PROJECTS_DIR
    links.refuse_escaping(projects, out, "the fleet projects directory")
    if projects.is_symlink() or not projects.is_dir():
        return []
    keep = {name.lower() for name in kept}
    ours = {name.lower(): value for name, value in read_ledger(out).items()}
    removed = []
    for path in sorted(projects.iterdir()):
        name = path.name.lower()
        if name in keep or name not in ours or path.suffix != ".html":
            continue
        if path.is_symlink() or not path.is_file():
            continue
        try:
            if digest(path.read_text(encoding="utf-8")) != ours[name]:
                continue  # edited since we wrote it — the operator's now
        except (OSError, UnicodeDecodeError):
            continue
        if not is_generated(path):
            continue
        links.refuse_escaping(path, out, f"stale fleet page {path.name}")
        try:
            path.unlink()
        except OSError as exc:
            raise HarnessError(
                f"could not remove the stale fleet page {path}: {exc.strerror} "
                "— delete it by hand, then re-run",
                1,
            ) from exc
        removed.append(path.name)
    return removed
