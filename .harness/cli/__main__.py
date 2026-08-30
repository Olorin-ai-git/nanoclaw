"""harness — command dispatch."""

import argparse
import os
import sys

from cli import (
    commands_dashboard,
    commands_fleet,
    commands_info,
    commands_init,
    commands_promote,
    commands_sync,
)
from cli.errors import HarnessError


def _install_command(sub, name: str, help_text: str, func) -> None:
    cmd = sub.add_parser(name, help=help_text)
    cmd.add_argument("--target", default=".", help="directory inside the target repo")
    cmd.add_argument("--canonical", default=None, help="canonical harness checkout")
    cmd.set_defaults(func=func)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="harness",
        description="Olorin project harness — install, sync, and inspect the "
        "self-improving goal scaffold in a git project.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init", help="install the scaffold into a git project")
    init.add_argument("--target", default=".", help="directory inside the target repo")
    init.add_argument("--project", default=None, help="project name (default: repo dir name)")
    init.add_argument("--canonical", default=None, help="canonical harness checkout")
    init.set_defaults(func=commands_init.run)

    _install_command(sub, "status", "per-unit staleness and drift", commands_info.status)
    _install_command(sub, "doctor", "install integrity checks", commands_info.doctor)
    _install_command(sub, "update", "pull canonical changes in (three-way merge)",
                     commands_sync.update)
    _install_command(sub, "promote", "push project drift upstream to canonical",
                     commands_promote.promote)
    _install_command(sub, "dashboard", "render the install to .harness/dashboard.html",
                     commands_dashboard.run)

    fleet = sub.add_parser(
        "fleet", help="render one page over every install under the given roots"
    )
    fleet.add_argument(
        "--roots", action="append", default=None,
        help="a project root, or a directory whose children are projects "
             f"(repeatable; default: ${commands_fleet.ROOTS_ENV})",
    )
    fleet.add_argument(
        "--out", default=None,
        help=f"directory to write the site into (default: ${commands_fleet.OUT_ENV})",
    )
    fleet.add_argument(
        "--exclude", action="append", default=None,
        help="a project to leave out, by directory name or path (repeatable; "
             f"default: ${commands_fleet.EXCLUDE_ENV})",
    )
    fleet.set_defaults(func=commands_fleet.run)

    resolve = sub.add_parser(
        "resolve", help="re-baseline a unit after manual conflict resolution"
    )
    resolve.add_argument("unit", help="unit id, as named by the conflict message")
    resolve.add_argument("--target", default=".", help="directory inside the target repo")
    resolve.add_argument("--canonical", default=None, help="canonical harness checkout")
    resolve.set_defaults(func=commands_sync.resolve)

    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except BrokenPipeError:
        # `harness status | head` closes the pipe early. That is the reader's
        # choice, not a harness failure: swallow it, and point stdout at
        # devnull so the interpreter's shutdown flush cannot report it either.
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        return 0
    except HarnessError as err:
        sys.stderr.write(f"harness: {err}\n")
        return err.exit_code
    except UnicodeDecodeError as err:
        # Bytes git handed back that are not text in this locale.
        sys.stderr.write(f"harness: unreadable output from git: {err}\n")
        return 1
    except OSError as err:
        # Belt for file-system failures no specific site anticipated: still a
        # one-line refusal, never a traceback.
        sys.stderr.write(f"harness: unexpected file-system error: {err}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
