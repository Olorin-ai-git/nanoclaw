"""Discover every harness install under a set of roots and summarise each one.

The fleet view answers one question a per-project dashboard cannot: across all
the projects that carry the harness, which ones are current, which are drifting,
and which are mid-goal. It therefore *reads* installs and never writes to them —
rendering the fleet must not mutate a project it merely reports on.

Roots come from the caller (flag or environment), never from a literal path in
this file: the set of projects is deployment configuration, and a default baked
in here would be wrong on every machine but one.
"""

import re
from pathlib import Path

from cli.dashboard_data import collect
from cli.errors import HarnessError
from cli.manifest import MANIFEST_REL

_STEP_RE = re.compile(r"PROCESS(?:\.md)? step:? (\d+)")
# Same shape the per-project dial accepts, so the two never disagree about
# which step a state line names.
_MAX_STEP_DIGITS = 9


def is_install(path: Path) -> bool:
    """Whether `path` is a project root with a harness install."""
    try:
        return (path / MANIFEST_REL).is_file()
    except OSError:
        return False


def identity(path: Path):
    """What makes two paths the same project, for deduplication.

    The filesystem's own answer — device and inode — rather than the resolved
    path string. `Path.resolve()` follows symlinks but does NOT canonicalise
    case, so on a case-insensitive filesystem `~/Documents/Projects` and
    `~/Documents/projects` are one directory with two distinct path strings:
    naming both produced two rows for every project, an exactly-doubled fleet.
    Falls back to the resolved path only when stat fails, where one extra row
    beats losing the project.
    """
    try:
        info = path.stat()
        return (info.st_dev, info.st_ino)
    except OSError:
        return str(path.resolve())


def excluded(path: Path, names: set) -> bool:
    """Whether a project is one the caller asked to leave out.

    Matched on the directory name, the resolved path, and **the name of the
    resolved directory** — all case-insensitively, because the filesystem here
    is. The third is what closes the obvious bypass: discovery accepts a
    symlinked child, so `elsewhere -> /path/EyeMix` would otherwise be scanned
    under a name the exclusion never mentions, and a project excluded by policy
    would appear in the dashboard through the side door.
    """
    if not names:
        return False
    resolved = path.resolve()
    return (path.name.lower() in names
            or str(resolved).lower() in names
            or resolved.name.lower() in names)


def discover(roots: list[Path], exclude: set | None = None) -> list[Path]:
    """Installs at each root, or among a root's immediate children.

    A root is accepted as a project itself when it holds an install, so a
    caller can name projects directly; otherwise its children are scanned, so
    a caller can name the directory their projects live in. One level only —
    a recursive walk would descend into node_modules and vendored checkouts.

    `exclude` drops projects the caller must not report on — this repo's
    PROCESS.md carries exactly such a rule — and it is applied to a root named
    directly as well as to a scanned child, so naming an excluded project
    explicitly does not smuggle it back in.
    """
    names = exclude or set()
    found: dict = {}
    for root in roots:
        root = root.expanduser()
        if is_install(root):
            if not excluded(root, names):
                found[identity(root)] = root
            continue
        try:
            children = sorted(root.iterdir())
        except OSError as exc:
            raise HarnessError(
                f"fleet root {root} cannot be listed: {exc.strerror} — name a "
                "directory that exists, or the project itself",
                1,
            ) from exc
        for child in children:
            if (child.is_dir() and is_install(child)
                    and not excluded(child, names)):
                found[identity(child)] = child
    return [found[key] for key in sorted(found, key=lambda k: found[k].name.lower())]


def active_step(state: str) -> int | None:
    """The PROCESS step number a state line names, or None."""
    match = _STEP_RE.search(state)
    if not match or len(match.group(1)) > _MAX_STEP_DIGITS:
        return None
    return int(match.group(1))


def summarise(project_dir: Path) -> dict:
    """One project's row: its own data plus the fleet-level derived fields.

    A project whose install is broken degrades to a row that says so. One
    unreadable install must not cost the operator the whole fleet view — that
    is exactly when they need it.
    """
    row = {"dir": str(project_dir), "name": project_dir.name}
    try:
        data = collect(str(project_dir))
    except (HarnessError, OSError) as exc:
        row.update({
            "broken": f"{exc}", "project": project_dir.name, "state": "",
            "units_total": 0, "units_current": 0, "runs": 0, "durable": 0,
            "step": None, "data": None, "canonical_reachable": False,
            "canonical_commit": "", "stale": [], "broken_units": [],
            "unverified": True,
        })
        return row
    units = data["units"]
    # A unit that could not be READ is not a unit that is merely behind: the
    # remedy the amber bucket implies (`harness update`) cannot fix a missing
    # host file, so the two are separated rather than summed.
    broken_units = [u["id"] for u in units if str(u["state"]).startswith("broken")]
    row.update({
        "broken": None,
        "project": data["project"],
        "state": data["state"],
        "step": active_step(data["state"]),
        "units_total": len(units),
        "units_current": sum(1 for u in units if u["state"] == "current"),
        "broken_units": broken_units,
        # With canonical unreachable, `unit_flags` cannot compute staleness at
        # all and every unit falls through as "current". `harness status` says
        # so out loud; reporting it here as a clean bill of health would be the
        # fleet view quietly inventing an assurance nothing checked.
        "unverified": not data["canonical_reachable"],
        "stale": [u["id"] for u in units
                  if u["state"] != "current" and u["id"] not in broken_units],
        "runs": len(data["runs"]),
        "durable": len(data["durable"]),
        "project_entries": len(data["project_entries"]),
        "canonical_commit": data["canonical_commit"],
        "canonical_reachable": data["canonical_reachable"],
        "latest_run": data["runs"][0]["title"] if data["runs"] else "",
        "data": data,
    })
    return row


def gather(roots: list[Path], exclude: set | None = None) -> list[dict]:
    """Every install under `roots`, summarised, in stable name order.

    Exclusion is applied twice, against two different names for the same
    project. `discover` drops it by directory name or path, which costs no I/O.
    The pass below drops it by the **configured project name** — the one the
    dashboard displays and therefore the one an operator will type — which is
    only known after the install is read. A project excluded by policy must not
    survive because the directory happens to be spelled differently from the
    name on the page.
    """
    installs = discover(roots, exclude)
    if not installs:
        # Naming the exclusions matters here: "no installs found" under a root
        # that plainly holds one reads as a bug until you see what was dropped.
        dropped = (f" (excluding {', '.join(sorted(exclude))})" if exclude else "")
        raise HarnessError(
            "no harness installs found under: "
            + ", ".join(str(r) for r in roots) + dropped
            + " — name a project root, or a directory whose children are projects",
            1,
        )
    rows = [summarise(path) for path in installs]
    if exclude:
        rows = [r for r in rows if r["project"].strip().lower() not in exclude]
    return rows
