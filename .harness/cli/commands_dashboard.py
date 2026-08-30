"""harness dashboard — render the install into a self-contained HTML page."""

import html
import math
import re
from pathlib import Path

from cli import fileio, ignores
from cli.dashboard_data import collect
from cli.dashboard_page import CSS, PAGE
from cli.errors import emit

INK = "#16202B"
CANON = "#1D5FBF"
PAPER_WHITE = "#FFFFFF"
MUTED = "#64748B"
GRID = "#E3E8ED"


def _dial(steps: list[str], state: str) -> str:
    """The loop dial: PROCESS steps as segments of a circle, active one lit."""
    active = -1
    match = re.search(r"PROCESS(?:\.md)? step:? (\d+)", state)
    # Bound the digit run rather than the match: truncating "00007" to four
    # digits would light a different step than the state line names.
    if match and len(match.group(1)) <= 9 and int(match.group(1)) < len(steps):
        active = int(match.group(1))
    cx, cy, radius = 150, 150, 108
    parts = [
        ('<svg viewBox="0 0 300 300" width="100%" role="img" '
         'aria-label="goal loop dial">')
    ]
    count = max(len(steps), 1)
    for index, step in enumerate(steps):
        angle = -90 + index * (360 / count)
        rad = math.radians(angle)
        x = cx + radius * math.cos(rad)
        y = cy + radius * math.sin(rad)
        lit = index == active
        parts.append(
            f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{15 if lit else 11}" '
            f'fill="{CANON if lit else PAPER_WHITE}" '
            f'stroke="{CANON if lit else INK}" stroke-width="1.5"/>'
        )
        parts.append(
            f'<text x="{x:.1f}" y="{y + 4:.1f}" text-anchor="middle" '
            f'font-size="11" font-family="SF Mono, Menlo, monospace" '
            f'fill="{PAPER_WHITE if lit else INK}">{index}</text>'
        )
        lx = cx + (radius - 34) * math.cos(rad)
        ly = cy + (radius - 34) * math.sin(rad)
        parts.append(
            f'<text x="{lx:.1f}" y="{ly + 3:.1f}" text-anchor="middle" font-size="8.5" '
            f'font-family="system-ui, sans-serif" fill="{MUTED}">{html.escape(step)}</text>'
        )
    parts.append(f'<circle cx="{cx}" cy="{cy}" r="{radius}" fill="none" '
                 f'stroke="{GRID}" stroke-width="1"/>')
    parts.append("</svg>")
    return "".join(parts)


def _chip(state: str) -> str:
    kind = "current" if state == "current" else ("broken" if state.startswith("broken") else "warn")
    return f'<span class="chip {kind}">{html.escape(state)}</span>'


def _cards(entries: list[dict], scope_class: str) -> str:
    if not entries:
        return '<div class="empty">No entries yet — SELF-IMPROVE.md step 2 writes them.</div>'
    out = []
    for entry in entries:
        out.append(
            f'<div class="card {scope_class}">'
            f'<span class="cat">{html.escape(entry["category"])}</span> '
            f'<span class="hl">HL-{html.escape(entry["id"])}</span>'
            f'<h3>{html.escape(entry["title"])}</h3>'
            f'<div class="instruction">{html.escape(entry["instruction"])}</div>'
            f'<div class="lineage">detected by: {html.escape(entry["detected_by"])}</div>'
            "</div>"
        )
    return "".join(out)


def render(data: dict) -> str:
    unit_rows = "".join(
        f'<tr><td>{html.escape(u["id"])}</td><td>{html.escape(u["type"])}</td>'
        f'<td>{html.escape(u["path"])}</td><td>{_chip(u["state"])}</td></tr>'
        for u in data["units"]
    )
    if data["ledger"]:
        ledger_rows = "".join(
            f'<div class="ledger-row"><span>{html.escape(row["when"])}</span>'
            f'<span class="proj">{html.escape(row["project"])}</span>'
            f'<span class="arrow">promoted into canonical</span>'
            f'<span class="sha">{html.escape(row["sha"])}</span></div>'
            for row in data["ledger"]
        )
    else:
        ledger_rows = ('<div class="empty">No promote commits visible — the ledger '
                       'reads the canonical checkout, which is unreachable or has '
                       'no promotes yet.</div>')
    run_rows = "".join(
        f'<li>{html.escape(r["file"])} — {html.escape(r["title"])}'
        + (f'<span class="goal">{html.escape(r["goal"])}</span>' if r["goal"] else "")
        + "</li>"
        for r in data["runs"]
    ) or '<li class="empty">No run journals yet.</li>'
    reflect_rows = "".join(
        f'<li class="{"recursive" if "this file" in step or "Recursive" in step else ""}">'
        f"{html.escape(step)}</li>"
        for step in data["reflect_steps"]
    ) or '<li class="empty">SELF-IMPROVE.md holds no numbered steps.</li>'
    canonical_note = ("reachable" if data["canonical_reachable"]
                      else "unreachable from this machine")
    ledger_scope_note = ("" if data["canonical_reachable"]
                         else " (canonical unreachable — record unavailable here)")
    return PAGE.format(
        reflect_rows=reflect_rows,
        ledger_scope_note=ledger_scope_note,
        css=CSS,
        project=html.escape(data["project"]),
        generated=html.escape(data["generated"]),
        canonical_commit=html.escape(data["canonical_commit"]),
        canonical_note=canonical_note,
        state=html.escape(data["state"]),
        dial=_dial(data["steps"], data["state"]),
        step_count=len(data["steps"]),
        unit_rows=unit_rows,
        ledger_rows=ledger_rows,
        durable_count=len(data["durable"]),
        durable_cards=_cards(data["durable"], ""),
        project_count=len(data["project_entries"]),
        project_cards=_cards(data["project_entries"], "project-scope"),
        run_rows=run_rows,
        root=html.escape(data["root"]),
    )


def run(args) -> int:
    data = collect(args.target, getattr(args, "canonical", None))
    harness_dir = Path(data["root"]) / ignores.HARNESS_DIR_NAME
    # The rendered page must never become tracked content: rules exist
    # before the artifact does, which also repairs pre-rule installs.
    if ignores.ensure_ignores(harness_dir, Path(data["root"])):
        emit(f"ignore rules added: {harness_dir / ignores.GITIGNORE_NAME}")
    out = harness_dir / ignores.DASHBOARD_NAME
    fileio.write_text(out, render(data), ignores.DASHBOARD_NAME,
                      inside=Path(data["root"]))
    emit(f"dashboard written: {out}")
    return 0
