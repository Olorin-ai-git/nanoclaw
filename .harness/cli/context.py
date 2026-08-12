"""Context-section placement and marker-safe appending (spec 6.7)."""

from pathlib import Path

from cli import fileio, links, units
from cli.errors import HarnessError


def _same_file(one: Path, two: Path) -> bool:
    """Whether two context paths are one file wearing two names.

    `CLAUDE.md -> AGENTS.md` is a common convention. Treating it as two
    files would splice the full block into the target and then a pointer
    block into what reads back as the same content — and, because writes
    replace the link rather than following it, would leave a duplicate
    regular file where the operator had a link.
    """
    try:
        return one.resolve() == two.resolve()
    except OSError:
        return False


def context_placement(root: Path) -> list[dict]:
    """Which context units go into which files (spec 6.7)."""
    claude_path, agents_path = root / "CLAUDE.md", root / "AGENTS.md"
    claude, agents = claude_path.is_file(), agents_path.is_file()
    full = {"id": "context-agents", "type": "section", "marker": "harness:context",
            "template": "templates/context/harness-context.md"}
    pointer = {"id": "context-pointer", "type": "section", "marker": "harness:pointer",
               "template": "templates/context/harness-pointer.md"}
    if claude and agents and not _same_file(claude_path, agents_path):
        return [dict(full, path="AGENTS.md"), dict(pointer, path="CLAUDE.md")]
    if claude and not agents:
        return [dict(full, path="CLAUDE.md")]
    return [dict(full, path="AGENTS.md")]


def append_context_block(root: Path, unit: dict, canonical: Path) -> None:
    """Append the marker-delimited block; repair an existing one to current
    canonical content (a stale block kept as-is would read as promotable drift)."""
    host = root / unit["path"]
    what = f"context file {unit['path']}"
    # A context host may be the operator's link (CLAUDE.md -> AGENTS.md), so
    # edit the file they actually pointed at — bounded to the project by the
    # shared policy, which also refuses a target outside it. Resolved here as
    # well as inside the write, because the read below must come from the
    # same file the write lands in.
    host = links.write_target(host, root, what)
    text = fileio.read_text(host, what) if host.is_file() else ""
    block = fileio.read_text(canonical / unit["template"], "context template")
    pairs = units.count_marker_pairs(text, unit["marker"])
    if pairs == 1:
        try:
            inner = units.extract_section(block, unit["marker"])
            spliced = units.splice_section(text, unit["marker"], inner)
        except HarnessError as exc:
            raise HarnessError(
                f"{unit['path']}: {exc} — repair the file by hand, then re-run "
                "harness init",
                1,
            ) from exc
        fileio.write_text(host, spliced, what, inside=root)
        return
    begin_token = f"<!-- {unit['marker']}:begin -->"
    end_token = f"<!-- {unit['marker']}:end -->"
    if pairs > 1 or begin_token in text or end_token in text:
        raise HarnessError(
            f"{unit['path']} holds broken or duplicated {unit['marker']} marker "
            "tokens — repair the file by hand, then re-run harness init",
            1,
        )
    joint = "" if not text else ("\n" if text.endswith("\n") else "\n\n")
    fileio.write_text(host, text + joint + block, what, inside=root)
