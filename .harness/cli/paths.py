"""Project-root and canonical-home resolution."""

from collections.abc import Mapping
from pathlib import Path

from cli.errors import HarnessError

ENV_HOME = "OLORIN_HARNESS_HOME"


def find_git_root(start: Path) -> Path:
    current = start.resolve()
    for candidate in (current, *current.parents):
        if (candidate / ".git").exists():
            return candidate
    raise HarnessError(f"not inside a git repository: {start}", 1)


def _is_canonical(path: Path) -> bool:
    return (path / "templates").is_dir()


def _expand(value: str) -> Path:
    """~ expansion that refuses in one line instead of raising RuntimeError.

    A ~user with no such user on the machine is ordinary bad input — it
    arrives from a flag, an env var, or a recorded manifest path — and must
    read as a refusal, never as a traceback."""
    try:
        return Path(value).expanduser()
    except (RuntimeError, ValueError, OSError) as exc:
        raise HarnessError(f"cannot expand the path {value}: {exc}", 1) from exc


def resolve_canonical(
    flag: str | None,
    env: Mapping[str, str],
    recorded: str | None,
    *,
    required: bool,
) -> Path | None:
    tried: list[str] = []
    # An explicit source (flag or env) that names a non-canonical directory is
    # a hard error — silently falling through would sync against a different
    # canonical than the one the operator asked for.
    for label, value in (("--canonical", flag), (ENV_HOME, env.get(ENV_HOME))):
        if not value:
            continue
        path = _expand(value)
        if _is_canonical(path):
            return path.resolve()
        raise HarnessError(
            f"{label}={value} is not a canonical harness checkout "
            "(no templates/ directory there)",
            1,
        )
    if recorded:
        path = _expand(recorded)
        if _is_canonical(path):
            return path.resolve()
        tried.append(f"recorded canonical path={recorded} (no templates/ directory there)")
    if not required:
        return None
    detail = "; ".join(tried) if tried else "no source set"
    raise HarnessError(
        "canonical harness home not found — pass --canonical, set "
        f"{ENV_HOME}, or run from an installed project ({detail})",
        1,
    )


def scrubbed_git_env() -> dict:
    """Environment for git subprocesses with repo-redirecting vars removed,
    so a harness run from inside a git hook still sees the right repo."""
    import os

    env = dict(os.environ)
    for var in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE",
                "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"):
        env.pop(var, None)
    return env


def own_home() -> Path | None:
    """The canonical checkout this CLI runs from, when it is one."""
    home = Path(__file__).resolve().parent.parent
    return home if _is_canonical(home) else None
