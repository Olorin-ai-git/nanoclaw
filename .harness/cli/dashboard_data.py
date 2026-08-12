"""Collect everything the dashboard shows from the install and canonical."""

import datetime
import re
from pathlib import Path

from cli import config, fileio, units
from cli.commands_info import load_install, resolve_soft, state_word, unit_flags
from cli.errors import HarnessError
from cli.gitcmd import run_git

_FIELD_RE = re.compile(r"^- (category|scope|detected-by|instruction): (.+)$", re.MULTILINE)


def parse_entries(section_text: str) -> list[dict]:
    entries = []
    parts = re.split(r"(?m)(?=^### HL-)", section_text)
    for part in parts:
        match = re.match(r"### HL-([0-9a-f]{8}) — (.+)", part)
        if not match:
            continue
        fields = dict(_FIELD_RE.findall(part))
        entries.append({
            "id": match.group(1),
            "title": match.group(2).strip(),
            "category": fields.get("category", ""),
            "detected_by": fields.get("detected-by", ""),
            "instruction": fields.get("instruction", ""),
        })
    return entries


def _state_line(root: Path) -> str:
    state = root / ".harness/STATE.md"
    if not state.is_file():
        return "STATE.md is missing"
    try:
        text = fileio.read_text(state, "STATE.md")
    except HarnessError as err:
        return f"STATE.md unreadable — {err}"
    for line in text.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            return stripped
    return "STATE.md holds no state line"


def _runs(root: Path) -> list[dict]:
    runs_dir = root / ".harness/runs"
    out = []
    if not runs_dir.is_dir():
        return out
    try:
        journals = sorted(runs_dir.iterdir(), reverse=True)
    except OSError as err:
        # An unlistable runs/ degrades its own panel, like an unreadable one.
        return [{"file": ".harness/runs", "title": f"broken: {err.strerror}",
                 "goal": ""}]
    for path in journals:
        if path.name.startswith(".") or not path.is_file():
            continue
        title = path.stem
        goal = ""
        # One unreadable journal degrades its own row, never the whole page.
        try:
            lines = fileio.read_text(path, path.name).splitlines()
        except HarnessError as err:
            out.append({"file": path.name, "title": f"broken: {err}", "goal": ""})
            continue
        for index, line in enumerate(lines):
            if line.startswith("# ") and title == path.stem:
                title = line[2:].strip()
            if line.strip().lower().startswith("## goal"):
                for candidate in lines[index + 1:]:
                    if candidate.strip():
                        goal = candidate.strip()
                        break
        out.append({"file": path.name, "title": title, "goal": goal})
    return out


def _unit_rows(root: Path, canonical: Path | None, mani: dict) -> list[dict]:
    rows = []
    for unit in mani["units"]:
        row = {"id": unit["id"], "type": unit["type"], "path": unit["path"]}
        try:
            # One computation, one wording: the same flags status prints.
            row["stale"], row["drift"] = unit_flags(root, canonical, unit)
            row["state"] = state_word(row["stale"], row["drift"])
        except HarnessError as err:
            row["state"] = f"broken: {err}"
        rows.append(row)
    return rows


def _promote_ledger(canonical: Path | None) -> list[dict]:
    """Every promote commit in canonical history — the full record, uncapped."""
    if canonical is None:
        return []
    try:
        res = run_git(
            canonical, "log", "--format=%h%x09%cI%x09%s",
            "--grep=^harness: promote from ", check=False,
        )
    except HarnessError:
        # No git on this machine: the ledger degrades like an unreachable canonical.
        return []
    if res.returncode != 0:
        return []
    ledger = []
    for line in res.stdout.splitlines():
        sha, _, rest = line.partition("\t")
        when, _, subject = rest.partition("\t")
        if subject.startswith("harness: promote from "):
            ledger.append({
                "sha": sha,
                "when": when[:10],
                "project": subject.removeprefix("harness: promote from "),
            })
    return ledger


def collect(target, canonical_flag=None) -> dict:
    root, mani = load_install(target)
    try:
        project = config.load(root)["project"]
    except HarnessError:
        # A corrupt harness.json degrades the masthead, never the page.
        project = "(harness.json broken — run harness doctor)"
    canonical = resolve_soft(type("A", (), {"canonical": canonical_flag})(), mani)
    def _section(rel: str, marker: str) -> str:
        # One unreadable file degrades its own panel, never the whole page.
        try:
            return units.extract_section(
                fileio.read_text(root / rel, rel), marker
            )
        except HarnessError:
            return ""

    durable = _section(".harness/LEARNINGS.md", "harness:durable")
    project_sec = _section(".harness/LEARNINGS.md", "harness:project")
    # Steps come from the managed core section only — numbered lists in the
    # project-extensions section must not render phantom dial segments.
    steps = re.findall(
        r"(?m)^\d+\. \*\*(.+?)\*\*", _section(".harness/PROCESS.md", "harness:core")
    )
    reflect_steps = re.findall(
        r"(?m)^\d+\. (.+)$", _section(".harness/SELF-IMPROVE.md", "harness:core")
    )
    return {
        "reflect_steps": [re.sub(r"\*\*(.+?)\*\*", r"\1", s) for s in reflect_steps],
        "project": project,
        # Local time with the zone named: the stamp is read by whoever
        # opens the page, and an unlabelled clock is ambiguous to them.
        "generated": datetime.datetime.now(datetime.UTC).astimezone().strftime(
            "%Y-%m-%d %H:%M %Z"),
        "root": str(root),
        "canonical_path": mani["canonical"]["path"],
        "canonical_commit": str(mani["canonical"].get("commit", "unknown"))[:10],
        "canonical_reachable": canonical is not None,
        "state": _state_line(root),
        "steps": steps,
        "units": _unit_rows(root, canonical, mani),
        "durable": parse_entries(durable),
        "project_entries": parse_entries(project_sec),
        "runs": _runs(root),
        "ledger": _promote_ledger(canonical),
    }
