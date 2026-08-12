"""Fleet index frame and styles — the per-project look, extended, not re-invented.

The project page's CSS is imported rather than copied: two stylesheets for one
product drift apart, and the fleet index is the same publication as the pages it
links to. Only the rules the index needs and the project page does not are
added here.
"""

import datetime
import html
from pathlib import Path

from cli.dashboard_page import CSS as PROJECT_CSS
from cli.errors import HarnessError
from cli.fleet_template import INDEX


def stamp() -> str:
    """Local time with the zone named: the page is read from anywhere, so an
    unlabelled clock is ambiguous to whoever opens it."""
    return datetime.datetime.now(datetime.UTC).astimezone().strftime(
        "%Y-%m-%d %H:%M %Z")


def splice(text: str, anchor: str, addition: str, *, after: bool) -> str:
    """`addition` inserted at the first `anchor`, which is kept.

    Written with `partition` rather than `str.replace(..., 1)` on purpose: the
    write-policy scan cannot tell `str.replace` from `Path.replace` — an atomic
    rename — so it counts every ambiguous receiver and fails closed. Earning an
    EXEMPT entry for a string operation would put a rationale in that table with
    nothing to do with paths, and every future reader would have to re-derive it
    (HL-1afc4488). Not calling the ambiguous method costs nothing.

    A missing anchor raises rather than returning the text unchanged: the only
    way it goes missing is the project template being restructured, and a
    silently un-spliced page is a fleet whose pages have no way back.
    """
    head, found, tail = text.partition(anchor)
    if not found:
        raise HarnessError(
            f"the project page has no {anchor!r} for the fleet back-link — the "
            "dashboard template changed; update cli/fleet_page.py to match",
            1,
        )
    return (f"{head}{found}{addition}{tail}" if after
            else f"{head}{addition}{found}{tail}")


# Injected into the per-project pages too, which are rendered by the project
# renderer and know nothing about the fleet: the back-link is the only fleet
# element they carry, so it brings its own rules rather than the project page
# growing a dependency on this module.
CRUMB_CSS = """
.crumb { font-size: 12px; margin-bottom: 14px; }
.crumb a { color: var(--canon); text-decoration: none; }
.crumb a:hover { text-decoration: underline; }
"""

FLEET_CSS = PROJECT_CSS + CRUMB_CSS + """
.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 14px; margin-top: 20px; }
.stat { background: #fff; border: 1px solid var(--grid); border-top: 3px solid var(--ink);
  padding: 12px 14px; }
.stat .n { font-family: "SF Mono", Menlo, monospace; font-size: 26px; display: block;
  line-height: 1.1; }
.stat .k { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--muted); }
.stat.alert { border-top-color: var(--broken); }
.stat.alert .n { color: var(--broken); }
td.proj a { color: var(--canon); text-decoration: none; font-weight: 600; }
td.proj a:hover { text-decoration: underline; }
td.stateline { color: var(--muted); font-size: 11.5px; max-width: 420px; }
.step-pip { display: inline-block; width: 20px; height: 20px; line-height: 20px;
  border-radius: 50%; text-align: center; font-size: 11px; font-weight: 600;
  background: var(--canon); color: #fff; }
.step-pip.idle { background: #fff; color: var(--muted); border: 1px solid var(--grid); }
.foot { margin-top: 40px; font-size: 11.5px; color: var(--muted);
  border-top: 1px solid var(--grid); padding-top: 12px; }
table.legend { margin-top: 14px; }
table.legend td { font-size: 12.5px; vertical-align: top; }
table.legend td.mono { white-space: nowrap; }
"""



def units_chip(row: dict) -> str:
    """The unit state, ranked worst-first — a clean count must not outrank an
    unreadable unit or a check that never ran."""
    if row["broken"]:
        return '<span class="chip broken">broken</span>'
    total = row["units_total"]
    if row["broken_units"]:
        return (f'<span class="chip broken">{len(row["broken_units"])} of {total}'
                f' BROKEN: {html.escape(", ".join(row["broken_units"]))}'
                ' — read the project, update cannot fix this</span>')
    if row["stale"]:
        return (f'<span class="chip warn">{row["units_current"]}/{total}'
                f' — stale: {html.escape(", ".join(row["stale"]))}'
                ' — run harness update</span>')
    if row["unverified"]:
        return (f'<span class="chip warn">{total} units, unverified'
                ' — canonical unreachable, no staleness check ran</span>')
    return f'<span class="chip current">{row["units_current"]}/{total} current</span>'


def _row(row: dict, href: str | None) -> str:
    name = html.escape(row["project"])
    cell = f'<a href="{html.escape(href)}">{name}</a>' if href else name
    step = (f'<span class="step-pip">{row["step"]}</span>'
            if row["step"] is not None else '<span class="step-pip idle">–</span>')
    state = html.escape(row["broken"] or row["state"] or "no state line")
    return (f'<tr><td class="proj">{cell}</td><td>{units_chip(row)}</td>'
            f'<td>{step}</td><td class="mono">{row["runs"]}</td>'
            f'<td class="stateline">{state}</td></tr>')


def render_index(rows: list[dict], hrefs: dict, roots: list[Path]) -> str:
    # "broken" counts unreadable installs AND readable ones holding a unit that
    # cannot be read: both need a human, and neither is fixed by an update.
    broken = sum(1 for r in rows if r["broken"] or r["broken_units"])
    drifting = sum(1 for r in rows
                   if not r["broken"] and not r["broken_units"] and r["stale"])
    unverified = sum(1 for r in rows if not r["broken"] and r["unverified"])
    commits = {r["canonical_commit"] for r in rows if r["canonical_commit"]}
    return INDEX.format(
        css=FLEET_CSS,
        generated=stamp(),
        project_count=len(rows),
        root_count=len(roots),
        # Only a project whose staleness was actually CHECKED can be counted
        # current; an unreachable canonical means nothing was compared.
        all_current=sum(1 for r in rows
                        if not r["broken"] and not r["broken_units"]
                        and not r["stale"] and not r["unverified"]),
        unverified=unverified,
        unverified_class=" alert" if unverified else "",
        drifting=drifting,
        drift_class=" alert" if drifting else "",
        broken=broken,
        broken_class=" alert" if broken else "",
        active=sum(1 for r in rows if r["step"] is not None),
        journals=sum(r["runs"] for r in rows),
        rows="".join(_row(r, hrefs.get(r["dir"])) for r in rows),
        root_list=html.escape(", ".join(str(r) for r in roots)),
        canonical_commit=html.escape(
            commits.pop() if len(commits) == 1 else f"{len(commits)} revisions"
        ),
    )
