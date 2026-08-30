"""LEARNINGS.md entry parsing and cross-section deduplication by HL-id."""

import hashlib
import re

from cli import units

ENTRY_RE = re.compile(r"^### HL-([0-9a-f]{8}) — ", re.MULTILINE)
_SPLIT_RE = re.compile(r"(?m)(?=^### HL-)")


def hl_id(title: str) -> str:
    """Content-stable entry id: first 8 hex chars of sha256 of the title."""
    return hashlib.sha256(title.strip().encode("utf-8")).hexdigest()[:8]


def entry_ids(section_text: str) -> set[str]:
    return set(ENTRY_RE.findall(section_text))


def strip_entries(section_text: str, banned: set[str]) -> str:
    """Remove every entry block whose id is in banned; keep everything else."""
    kept = []
    for part in _SPLIT_RE.split(section_text):
        match = ENTRY_RE.match(part)
        if match and match.group(1) in banned:
            continue
        kept.append(part)
    return "".join(kept)


def normalize_learnings(text: str) -> tuple[str, list[str]]:
    """Dedupe within the durable section, then drop project-section entries
    whose id also lives in the durable section. Returns (text, removed ids)."""
    removed: list[str] = []
    durable = units.extract_section(text, "harness:durable")
    deduped = dedupe_section(durable)
    if deduped != durable:
        removed.append("duplicate durable entries collapsed")
        text = units.splice_section(text, "harness:durable", deduped)
        durable = deduped
    project = units.extract_section(text, "harness:project")
    dupes = entry_ids(durable) & entry_ids(project)
    if dupes:
        removed.extend(sorted(f"HL-{d}" for d in dupes))
        text = units.splice_section(text, "harness:project", strip_entries(project, dupes))
    return text, removed


def collapse_trailing_blanks(section_text: str) -> str:
    """One trailing newline at most for a marked section. Entry blocks end with
    a blank line, so concatenating them leaves the section ending in one — and
    a section that ends blank makes every baseline cut from it end blank too.
    """
    if section_text.endswith("\n\n"):
        return section_text.rstrip("\n") + "\n"
    return section_text


def dedupe_section(section_text: str) -> str:
    """Keep only the first occurrence of each entry id within one section."""
    seen: set[str] = set()
    kept = []
    for part in _SPLIT_RE.split(section_text):
        match = ENTRY_RE.match(part)
        if match:
            if match.group(1) in seen:
                continue
            seen.add(match.group(1))
        kept.append(part)
    return "".join(kept)
