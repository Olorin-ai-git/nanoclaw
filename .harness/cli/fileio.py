"""Shared file IO: verbatim reads, atomic writes, clean refusals.

Every file the harness reads or writes goes through here. Two invariants the
rest of the CLI depends on:

* **Verbatim** — `newline=""` disables newline translation in both directions,
  so a CRLF host file keeps its CRLF bytes outside the region being spliced.
* **Atomic** — writes land via a sibling `.new` file and `os.replace`, so a
  crash leaves the previous file wholly intact rather than truncated.
* **Link-safe** — no write follows or replaces a symlink the operator placed
  unless the caller opts in and the target stays inside the project. The rule
  lives in `links`; this is the one place that applies it, so a new writer
  cannot forget it. See `links` for why that matters.
"""

import os
from pathlib import Path

from cli import links
from cli.errors import HarnessError

# The staging suffix is namespaced so it can never collide with (and
# destroy) an unrelated user file sitting next to the target. Defined with
# the write policy in `links`; re-exported here because this is where
# callers expect it.
ATOMIC_SUFFIX = links.ATOMIC_SUFFIX


def read_text(path: Path, what: str) -> str:
    """File content, byte-faithful, refusing unreadable paths with one line."""
    try:
        with open(path, encoding="utf-8", newline="") as handle:
            return handle.read()
    except UnicodeDecodeError as exc:
        raise HarnessError(
            f"{what} is not valid UTF-8 ({path}) — restore it from git history", 1
        ) from exc
    except OSError as exc:
        raise HarnessError(
            f"{what} could not be read ({path}): {exc.strerror} — "
            "restore it from git history",
            1,
        ) from exc


def write_text(
    path: Path, text: str, what: str, *, inside: Path, through_link: bool = False
) -> None:
    """Replace a file atomically, writing its characters unchanged.

    `inside` is the tree this write may not escape — the project root, the
    canonical home, or a staging tree. It is required rather than optional
    because a leaf-only check cannot see a symlinked parent directory, and a
    default would silently reintroduce exactly that hole.

    Refuses to replace a symlink at `path`. A caller that legitimately edits
    through the operator's link passes `through_link=True`: the link is then
    followed to its target, and refused when that target leaves `inside`.
    Every rule lives in `links`.
    """
    if through_link:
        path = links.write_target(path, inside, what)
    else:
        links.refuse_replacing(path, what)
    links.refuse_escaping(path, inside, what)
    staging = path.with_name(path.name + ATOMIC_SUFFIX)
    links.refuse_staging(staging, what)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        # O_NOFOLLOW closes the gap between the check above and this open: a
        # link appearing at the staging path in between is refused by the
        # kernel rather than followed.
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW
        with open(os.open(staging, flags, 0o666), "w",
                  encoding="utf-8", newline="", closefd=True) as handle:
            handle.write(text)
        os.replace(staging, path)
    except OSError as exc:
        raise HarnessError(
            f"{what} could not be written ({path}): {exc.strerror}", 1
        ) from exc
