"""harness fleet — one page over every install, linking to each project's own.

Reads the installs and writes only into the output directory. Rendering a view
of a project must never mutate the project: an operator pointing this at
twenty-six repos is asking a question, not authorising twenty-six writes.
"""

import os
from pathlib import Path

from cli import fileio
from cli.commands_dashboard import render as render_project
from cli.errors import HarnessError, emit
from cli.fleet_data import gather
from cli.fleet_out import (
    GENERATED_MARKER,
    INDEX_NAME,
    PROJECTS_DIR,
    digest,
    prune_stale_pages,
    slug,
    write_ledger,
)
from cli.fleet_page import CRUMB_CSS, render_index, splice
from cli.fleet_template import PROJECT_CRUMB

ROOTS_ENV = "OLORIN_HARNESS_FLEET_ROOTS"
OUT_ENV = "OLORIN_HARNESS_FLEET_OUT"
EXCLUDE_ENV = "OLORIN_HARNESS_FLEET_EXCLUDE"


def resolve_roots(args) -> list[Path]:
    """Roots from the flag, else the environment. Never a literal default."""
    if getattr(args, "roots", None):
        raw = list(args.roots)
    else:
        raw = [p for p in os.environ.get(ROOTS_ENV, "").split(os.pathsep) if p]
    if not raw:
        raise HarnessError(
            "no fleet roots given — pass --roots <dir> (repeatable) or set "
            f"{ROOTS_ENV} to a {os.pathsep!r}-separated list of directories",
            1,
        )
    return [Path(p).expanduser() for p in raw]


def resolve_excludes(args) -> set:
    """Projects to leave out, by directory name or path, lowercased.

    A project can be out of scope by policy — this repo's PROCESS.md excludes
    one by name — so the view has to be able to honour that. Lowercased once
    here so the comparison never has to think about it.
    """
    raw = list(getattr(args, "exclude", None) or [])
    if not raw:
        raw = [p for p in os.environ.get(EXCLUDE_ENV, "").split(os.pathsep) if p]
    return {item.strip().lower() for item in raw if item.strip()}


def resolve_out(args) -> Path:
    out = getattr(args, "out", None) or os.environ.get(OUT_ENV, "")
    if not out:
        raise HarnessError(
            f"no output directory — pass --out <dir> or set {OUT_ENV}", 1
        )
    return Path(out).expanduser()


def _project_page(row: dict, back_href: str) -> str:
    """The project's own page: the marker, a back-link, and its styles.

    The marker goes in first and after `<head>`, so a page cannot reach the
    output directory without carrying the only thing that authorises deleting
    it on a subsequent run.
    """
    page = splice(render_project(row["data"]), "<head>", GENERATED_MARKER,
                  after=True)
    page = splice(page, "</style>", CRUMB_CSS, after=False)
    return splice(page, '<div class="wrap">',
                  PROJECT_CRUMB.format(href=back_href), after=True)


def _build_pages(rows: list[dict]) -> tuple[list, dict]:
    """Every page rendered, and the index hrefs, before anything is written."""
    taken: set = set()
    hrefs: dict = {}
    built: list = []
    for row in rows:
        if row["broken"]:
            continue
        stem = slug(row["project"], taken)
        rel = f"{PROJECTS_DIR}/{stem}.html"
        hrefs[row["dir"]] = rel
        built.append((rel, f"{stem}.html",
                      _project_page(row, f"../{INDEX_NAME}"), row["project"]))
    return built, hrefs


BROKEN_EXIT = 2


def run(args) -> int:
    roots = resolve_roots(args)
    out = resolve_out(args)
    exclude = resolve_excludes(args)
    rows = gather(roots, exclude)
    # Render EVERYTHING before writing anything. A page that fails to render
    # then costs the run, not the published site: the previous index, pages and
    # ledger stay consistent with each other instead of being half replaced.
    built, hrefs = _build_pages(rows)
    index_html = render_index(rows, hrefs, roots)

    pages = {}
    for rel, name, text, project in built:
        fileio.write_text(out / rel, text, f"fleet page for {project}", inside=out)
        pages[name] = digest(text)
    fileio.write_text(out / INDEX_NAME, index_html, "fleet index", inside=out)
    # Pruning runs after the writes, so an interruption cannot delete a page
    # whose replacement had not landed yet; the ledger is written last, so an
    # interruption leaves the PREVIOUS record and the next run still knows
    # which files are its own.
    removed = prune_stale_pages(out, set(pages))
    write_ledger(out, pages, out)
    # Both shapes of broken, because both need a human and neither is fixed by
    # an update: an install that could not be READ at all, and a readable one
    # holding a unit that could not be read. The index already ranks them the
    # same way; the exit code must agree, or an unattended publish ships a
    # fleet with a BROKEN unit in it and reports success.
    broken = [r["name"] for r in rows if r["broken"] or r["broken_units"]]
    emit(f"fleet index written: {out / INDEX_NAME}")
    emit(f"{len(pages)} project page(s) written to {out / PROJECTS_DIR}")
    if exclude:
        # Said out loud: a reader counting rows should know the set was bounded
        # on purpose rather than wonder which project went missing.
        emit(f"excluded by request: {', '.join(sorted(exclude))}")
    if removed:
        emit(f"{len(removed)} stale page(s) removed: {', '.join(removed)}")
    if broken:
        # The page still renders — one broken install must never cost an
        # operator the other twenty-five — but the exit code carries the fact,
        # so an unattended publish can refuse to ship a fleet known to be
        # incomplete instead of succeeding quietly.
        emit(f"{len(broken)} install(s) reported as broken: {', '.join(broken)}")
        return BROKEN_EXIT
    return 0
