"""Recovery of pre-existing install state: fresh-partial detection and
preserve-don't-delete move-aside."""

import os
from pathlib import Path

from cli import fileio, ignores, links
from cli.errors import HarnessError


def fresh_partial(harness_dir: Path) -> bool:
    """True only for a .harness that a crashed init could have left behind:
    no run journals and no recorded active goal."""
    runs = harness_dir / "runs"
    if runs.is_dir():
        journals = [p for p in runs.iterdir() if not p.name.startswith(".")]
        if journals:
            return False
    state = harness_dir / "STATE.md"
    if state.is_file():
        try:
            text = fileio.read_text(state, "STATE.md")
        except HarnessError:
            # An unreadable STATE.md is not provably a fresh partial: refuse.
            return False
        for line in text.splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("#"):
                # The literal couples to the first content line templates/STATE.md ships.
                return stripped == "No active goal."
    return True


def move_aside(path: Path) -> Path:
    """Preserve rather than delete: rename to a numbered .abandoned sibling."""
    for n in range(1, 100):
        suffix = ".abandoned" if n == 1 else f".abandoned-{n}"
        target = path.with_name(path.name + suffix)
        if not target.exists():
            os.rename(path, target)
            ignores.self_ignore(target)
            return target
    raise HarnessError(
        f"too many abandoned copies next to {path} — clean them up first", 1
    )


def restore(saved: list[tuple[Path, bytes | None]], root: Path) -> None:
    """Put the project's own files back exactly as init found them.

    Best effort: a second failure while undoing must not replace the
    refusal the operator actually needs to read.

    Symlinks the operator placed are theirs. `before is None` means init found
    nothing readable there — for a link, that is a dangling or non-file target
    init never wrote, so deleting it would destroy plumbing this rollback is
    supposed to leave untouched. Writing back through a link is how a saved
    context host is restored (the bytes were read through the same link), but
    never when it leaves the project.

    The whole path is screened first, not just the leaf: a symlinked parent
    directory leaves the leaf an ordinary name while the unlink below deletes
    a file outside the project. Screened rather than refused, because this
    runs while unwinding a refusal and must never raise its own."""
    for path, before in reversed(saved):
        try:
            if not links.inside(path.resolve(), root):
                continue
            if path.is_symlink():
                target = links.target_of(path)
                if before is None or target is None or not links.inside(target, root):
                    continue
            if before is None:
                path.unlink(missing_ok=True)
            else:
                path.write_bytes(before)
        except OSError:
            continue
