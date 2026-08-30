"""Error type and the single stdout channel for the harness CLI."""

import sys


class HarnessError(Exception):
    """Failure that ends the command with an actionable one-line message."""

    def __init__(self, message: str, exit_code: int = 1):
        super().__init__(message)
        self.exit_code = exit_code


def emit(msg: str) -> None:
    """All user-facing command output flows through here.

    Flushed per line: stdout is block-buffered into a pipe, so without this
    a refusal written to stderr would overtake the accounting written here,
    and every captured run would show them in the wrong order."""
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()
