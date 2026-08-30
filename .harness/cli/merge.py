"""Three-way text merge over ``git merge-file``."""

import shutil
import subprocess
from pathlib import Path

from cli import links
from cli.errors import HarnessError
from cli.ignores import HARNESS_DIR_NAME, MERGEWORK_NAME


def merge3(
    base: str,
    ours: str,
    theirs: str,
    labels: tuple[str, str, str],
    root: Path,
) -> tuple[str, bool]:
    """Merge ``ours`` and ``theirs`` against their common ``base``.

    Writes the three texts under ``root/.harness/mergework``, runs
    ``git merge-file -p`` with ``labels`` as the (ours, base, theirs)
    conflict-marker names, and returns ``(merged_text, conflicted)``.
    ``git merge-file`` exits with the number of conflicts, so any positive
    return code means the merged text carries conflict markers.

    ``root`` is the project this scratch tree may not escape, and the scratch
    path is derived forward from it rather than passed alongside it: two
    parameters carrying the same fact are two a caller can make disagree, and
    the one the check runs against would not be the one being written.
    """
    work = root / HARNESS_DIR_NAME / MERGEWORK_NAME
    if work.is_symlink():
        # mkdir(exist_ok=True) follows a link, and the three scratch files
        # would then be written wherever it points — over whatever sits
        # there, and beyond the reach of the cleanup below.
        raise HarnessError(
            f"{work} is a symlink — the merge scratch directory must be a real "
            "directory inside the install; remove the link, then re-run",
            1,
        )
    # The link need not be the leaf: a symlinked `.harness` leaves `work` an
    # ordinary path while the rmtree below deletes a directory outside the
    # project. Only the fully resolved path sees that.
    links.refuse_escaping(work, root, "the merge scratch directory")
    # Clear the whole directory rather than reusing it: checking the three
    # names below would leave any other pre-placed link in the tree, and
    # rmtree never follows links out of it. Scratch content is worthless by
    # definition, so there is nothing here to preserve.
    shutil.rmtree(work, ignore_errors=True)
    try:
        work.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise HarnessError(
            f"cannot create merge working directory {work}: {exc} — "
            "remove whatever occupies that name",
            1,
        ) from exc
    try:
        names = {}
        for name, text in (("base", base), ("ours", ours), ("theirs", theirs)):
            p = work / name
            p.write_bytes(text.encode("utf-8"))
            names[name] = p
        # Bytes in and out: subprocess text mode would rewrite CRLF to LF in
        # the merged output, corrupting hosts that legitimately use CRLF.
        res = subprocess.run(
            [
                "git", "merge-file", "-p",
                "-L", labels[0], "-L", labels[1], "-L", labels[2],
                str(names["ours"]), str(names["base"]), str(names["theirs"]),
            ],
            # check=False: git merge-file exits with the CONFLICT COUNT, so a
            # non-zero status is the normal result this function reports, not
            # a failure to raise on.
            capture_output=True, check=False,
        )
        if res.returncode < 0 or res.returncode >= 128:
            raise HarnessError(
                f"git merge-file failed: {res.stderr.decode('utf-8', 'replace').strip()}",
                1,
            )
        return res.stdout.decode("utf-8"), res.returncode > 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


def has_conflict_markers(text: str) -> bool:
    """True only when both an ours line and a theirs line are present.

    Requires a line starting ``<<<<<<< `` and a line starting ``>>>>>>> ``.
    A lone ``=======`` line is a legal markdown setext underline and never
    counts on its own.
    """
    opened = False
    closed = False
    for line in text.splitlines():
        if line.startswith("<<<<<<< "):
            opened = True
        elif line.startswith(">>>>>>> "):
            closed = True
        if opened and closed:
            return True
    return False
