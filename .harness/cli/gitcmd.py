"""Git subprocess helpers: scrubbed environment, clean refusals."""

import subprocess
from pathlib import Path

from cli.errors import HarnessError
from cli.paths import scrubbed_git_env


def run_git(repo: Path, *argv: str, check: bool = True,
            input_text: str | None = None):
    """Run git in a repo with repo-redirecting env vars scrubbed."""
    try:
        # check=False: this function raises its own HarnessError below when
        # `check` is set, so CalledProcessError would bypass the one-line
        # refusal every caller expects.
        res = subprocess.run(
            ["git", "-C", str(repo), *argv],
            capture_output=True, text=True, env=scrubbed_git_env(),
            input=input_text, check=False,
        )
    except FileNotFoundError as exc:
        raise HarnessError(
            "git is required but was not found on PATH", 1
        ) from exc
    if check and res.returncode != 0:
        raise HarnessError(
            f"git {' '.join(argv)} failed in {repo}: {res.stderr.strip()}", 1
        )
    return res


def real_dirt(status_stdout: str) -> list[str]:
    """Porcelain lines naming distributable content — bytecode caches and
    hidden files are never distributed, so they are not dirt."""
    return [
        line for line in status_stdout.splitlines()
        if "__pycache__" not in line
        and not Path(line[3:].strip().strip('"')).name.startswith(".")
    ]


def head_commit(repo: Path) -> str:
    res = run_git(repo, "rev-parse", "HEAD", check=False)
    return res.stdout.strip() if res.returncode == 0 else "unknown"


def check_canonical_settled(
    canonical: Path, paths: tuple[str, ...] = ("templates/", "cli/", "bin/")
) -> None:
    """Refuse to distribute uncommitted canonical content.

    Baselining or vendoring transient working-tree content would let a
    subsequent canonical revert silently erase real project drift — or ship a
    CLI that matches no commit. A non-git canonical copy has no transience
    signal and is accepted as-is.
    """
    inside = run_git(canonical, "rev-parse", "--is-inside-work-tree", check=False)
    if inside.returncode != 0 or inside.stdout.strip() != "true":
        return
    dirty = run_git(canonical, "status", "--porcelain", "--", *paths)
    # Bytecode caches and hidden files are never distributed (the copy and the
    # hash map both exclude them), so they are not dirt for this check either.
    if real_dirt(dirty.stdout):
        raise HarnessError(
            f"canonical tree is dirty in {canonical} under {', '.join(paths)} — "
            "commit or clean it there first, so this install does not receive "
            "content that may never be committed",
            1,
        )
