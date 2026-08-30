"""Managed-unit content access: marker-section extraction, splicing, unit IO.

A section unit is the region between ``<!-- <marker>:begin -->`` and
``<!-- <marker>:end -->`` inside a host file; everything outside the pair is
project-owned and must survive any splice byte-for-byte. A file unit is the
whole file.
"""

from pathlib import Path

from cli import fileio
from cli.errors import HarnessError

# Context hosts are the project's own doc files, where `CLAUDE.md -> AGENTS.md`
# is a documented convention — the one place a harness write may follow the
# operator's link (bounded to the project by `links`). Every other managed
# path refuses instead. Kept here, not in `context`, because `context` imports
# this module and the discriminator must be importable from both sides.
CONTEXT_MARKERS = ("harness:context", "harness:pointer")


def follows_operator_link(unit: dict) -> bool:
    """Whether this unit's host may be edited through a symlink."""
    return unit.get("marker") in CONTEXT_MARKERS


def _begin(marker: str) -> str:
    return f"<!-- {marker}:begin -->"


def _end(marker: str) -> str:
    return f"<!-- {marker}:end -->"


def count_marker_pairs(text: str, marker: str) -> int:
    """Number of complete begin->end pairs for the marker, scanning left to right."""
    begin, end = _begin(marker), _end(marker)
    count = 0
    pos = 0
    while True:
        b = text.find(begin, pos)
        if b < 0:
            return count
        e = text.find(end, b + len(begin))
        if e < 0:
            return count
        count += 1
        pos = e + len(end)


def _bounds(text: str, marker: str) -> tuple[int, int]:
    """Start/end indices of the single marked region (exclusive of markers).

    Requires exactly one begin token and exactly one end token — a stray extra
    token anywhere would silently widen the region, so it is refused instead.
    """
    begins = text.count(_begin(marker))
    ends = text.count(_end(marker))
    if begins != 1 or ends != 1 or count_marker_pairs(text, marker) != 1:
        raise HarnessError(
            f"expected exactly one {marker} marker pair, found "
            f"{begins} begin and {ends} end token(s)",
            1,
        )
    start = text.find(_begin(marker)) + len(_begin(marker))
    return start, text.find(_end(marker), start)


def extract_section(text: str, marker: str) -> str:
    """Content between the begin and end markers, exclusive."""
    start, stop = _bounds(text, marker)
    return text[start:stop]


def splice_section(text: str, marker: str, content: str) -> str:
    """Replace the marked region, preserving everything outside byte-for-byte."""
    start, stop = _bounds(text, marker)
    return text[:start] + content + text[stop:]


def read_unit(root: Path, unit: dict) -> str:
    """Current project-side text of a file or section unit."""
    host = root / unit["path"]
    if not host.is_file():
        raise HarnessError(
            f"unit {unit['id']}: missing file {unit['path']} under {root}", 1
        )
    text = fileio.read_text(host, f"unit {unit['id']} host file {unit['path']}")
    if unit["type"] == "section":
        try:
            return extract_section(text, unit["marker"])
        except HarnessError as exc:
            raise HarnessError(f"unit {unit['id']} ({unit['path']}): {exc}", 1) from exc
    if unit["type"] == "file":
        return text
    raise HarnessError(
        f"unit {unit['id']}: type {unit['type']!r} has no single text content", 1
    )


def write_unit(root: Path, unit: dict, content: str) -> None:
    """Write unit content back: overwrite a file unit, splice a section unit.

    Init and update must agree about the same file, so the link rule is the
    unit's property rather than the command's: a context host is followed into
    the project, everything else refuses a symlink instead of replacing it.
    """
    host = root / unit["path"]
    what = f"unit {unit['id']} host file {unit['path']}"
    if unit["type"] == "section":
        if not host.is_file():
            raise HarnessError(
                f"unit {unit['id']}: missing file {unit['path']} under {root}", 1
            )
        text = fileio.read_text(host, what)
        try:
            spliced = splice_section(text, unit["marker"], content)
        except HarnessError as exc:
            raise HarnessError(f"unit {unit['id']} ({unit['path']}): {exc}", 1) from exc
        fileio.write_text(host, spliced, what, inside=root,
                          through_link=follows_operator_link(unit))
        return
    if unit["type"] == "file":
        fileio.write_text(host, content, what, inside=root,
                          through_link=follows_operator_link(unit))
        return
    raise HarnessError(
        f"unit {unit['id']}: type {unit['type']!r} cannot be written as text", 1
    )


def canonical_unit_text(canonical: Path, unit: dict) -> str:
    """Canonical-side text of a unit, read from its template file."""
    template = canonical / unit["template"]
    if not template.is_file():
        raise HarnessError(
            f"unit {unit['id']}: canonical template {unit['template']} "
            f"missing under {canonical}",
            1,
        )
    text = fileio.read_text(
        template, f"unit {unit['id']} canonical template {unit['template']}"
    )
    if unit["type"] == "section":
        return extract_section(text, unit["marker"])
    return text


def project_section_problem(text: str) -> str | None:
    """What is wrong with a host file's project-owned marker pair, if anything.

    Exact token counts, not pair counts: one complete pair plus a stray token
    would pass a pair count while still breaking extraction.
    """
    begins = text.count("<!-- harness:project:begin -->")
    ends = text.count("<!-- harness:project:end -->")
    if (begins, ends) == (1, 1):
        return None
    return (f"expected one harness:project pair, found {begins} begin and "
            f"{ends} end token(s)")
