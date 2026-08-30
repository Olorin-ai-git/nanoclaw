"""{{VAR}} substitution for the one template that carries variables (EVALS.md)."""

import re

from cli.errors import HarnessError

_TOKEN = re.compile(r"\{\{\s*([A-Za-z0-9_]+)\s*\}\}")


def render(text: str, values: dict[str, str]) -> str:
    """Replace every {{KEY}} with values[KEY].

    Raises HarnessError naming every {{...}} token still present after
    substitution — including tokens smuggled in by a substitution value —
    so nothing half-rendered ever lands on disk.
    """

    def _sub(match: re.Match[str]) -> str:
        return values.get(match.group(1), match.group(0))

    rendered = _TOKEN.sub(_sub, text)
    unresolved = sorted({m.group(0) for m in _TOKEN.finditer(rendered)})
    if unresolved:
        raise HarnessError(
            "unreplaced substitution tokens: " + ", ".join(unresolved), 1
        )
    return rendered
