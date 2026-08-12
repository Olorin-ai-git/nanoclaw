"""Import smoke-check for a staged copy of the vendored CLI."""

import os
import subprocess
import sys
from pathlib import Path

from cli.errors import HarnessError


def smoke_staged_cli(stage: Path) -> None:
    """Prove the staged CLI actually imports before it lands in an install."""
    # -B: the probe must not mint __pycache__ into the tree it vets — the
    # staged copy is renamed into the install as-is.
    # check=False: a failed import is the answer this probe exists to get, and
    # it is reported below with the interpreter's own last line.
    res = subprocess.run(
        [sys.executable, "-P", "-B", "-c", "import cli.__main__"],
        capture_output=True, text=True,
        env={**os.environ, "PYTHONPATH": str(stage)}, check=False,
    )
    if res.returncode != 0:
        detail = res.stderr.strip().splitlines()[-1] if res.stderr.strip() else "no output"
        raise HarnessError(
            f"staged vendored CLI failed its import check ({detail}) — the "
            "canonical cli/ tree is broken; fix it there, then re-run",
            1,
        )
