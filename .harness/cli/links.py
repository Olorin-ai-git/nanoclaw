"""Symlink policy: what the harness may write through, and what it refuses.

The harness writes into a project it does not own, and operators put symlinks
in the paths it manages. Two ways that destroys data: **following** a link
lands harness content wherever it points, outside the project and beyond the
reach of any cleanup this program can run; **replacing** a link with a regular
file destroys plumbing the operator put there on purpose and orphans the
content they actually read.

The policy therefore lives here, once, and `fileio` applies it to every write.
Deliberately not a per-call-site check: audit rounds kept fixing instances
where they were found and kept finding another, because a policy that lives at
the leaves is a policy the next writer forgets.

**Refusal is the default.** Following a link is opt-in and bounded — the
resolved target must stay inside the project. `CLAUDE.md -> AGENTS.md` is a
documented convention, and that single exception is why the opt-in exists.
"""

from pathlib import Path

from cli.errors import HarnessError

# The atomic-write staging suffix. It lives with the policy rather than in
# fileio because refusing to follow a link at this path IS the policy, and
# ignores builds a rule from the same constant.
ATOMIC_SUFFIX = ".harness-new"


def target_of(path: Path) -> Path | None:
    """Where a symlink points, fully resolved, or None when it is not a link.

    A link loop cannot be resolved; report the one hop we can read rather
    than raising, so a refusal message can still name what it found.
    """
    if not path.is_symlink():
        return None
    try:
        return path.resolve()
    except OSError:
        try:
            return path.readlink()
        except OSError:
            return path


def inside(target: Path, root: Path) -> bool:
    """Whether a resolved target stays within the project root."""
    try:
        return target.is_relative_to(root.resolve())
    except OSError:
        return False


def refuse_replacing(path: Path, what: str) -> None:
    """Refuse to overwrite a symlink the operator placed.

    Replacing it is silent damage: the link is gone, and the file they
    actually read keeps whatever content it had before.
    """
    target = target_of(path)
    if target is None:
        return
    raise HarnessError(
        f"{what} is a symlink ({path} -> {target}) — the harness will not "
        "replace plumbing you put there. Point the harness at a regular file, "
        "or edit the target directly, then re-run the command",
        1,
    )


def write_target(path: Path, root: Path, what: str) -> Path:
    """The file to write for a caller that may follow the operator's link.

    `path` unchanged when it is not a link; otherwise the resolved target,
    refusing when that target leaves the project. Following keeps the
    operator's plumbing intact — writing the link path itself would convert
    two names for one file into two files.
    """
    target = target_of(path)
    if target is None:
        return path
    if not inside(target, root):
        raise HarnessError(
            f"{what} is a symlink to {target}, outside the project — point it "
            "inside the repo or replace it with a regular file, then re-run "
            "the command",
            1,
        )
    return target


def refuse_escaping(path: Path, root: Path, what: str) -> None:
    """Refuse a write whose fully resolved path leaves `root`.

    The link does not have to be the last component. A symlinked *parent* —
    `.harness/baselines -> /somewhere/else` — leaves the leaf an ordinary
    file, so every leaf-only check passes while every write into it lands
    outside the project. Resolving the whole path is the only check that sees
    that, which is why this runs on every write and not just linked ones.

    `resolve()` is non-strict, so a file that does not exist yet still
    resolves through its existing parents and is judged correctly. The remedy
    differs by cause, so the message says which it found: a linked leaf is
    deleted, a linked parent directory is replaced.
    """
    try:
        resolved = path.resolve()
    except OSError as exc:
        raise HarnessError(
            f"{what} ({path}) cannot be resolved: {exc.strerror} — a symlink "
            "loop in the path; remove it, then re-run the command",
            1,
        ) from exc
    if inside(resolved, root):
        return
    if path.is_symlink():
        raise HarnessError(
            f"{what} ({path}) is itself a symlink to {resolved}, outside "
            f"{root} — delete the link; writing through it would land on "
            "files the harness does not own",
            1,
        )
    raise HarnessError(
        f"{what} resolves to {resolved}, outside {root} — a directory on the "
        "way there is a symlink pointing out of the project, so this write "
        "would land on files the harness does not own; replace that link with "
        "a real directory, then re-run the command",
        1,
    )


def refuse_staging(staging: Path, what: str) -> None:
    """Refuse a staging path occupied by anything but a regular file.

    No opt-out: following a link here writes harness content through it, and
    the rename then leaves the managed path itself pointing outside, so every
    write after that one escapes as well.
    """
    if staging.is_symlink():
        raise HarnessError(
            f"{what}: the staging path {staging} is a symlink "
            f"(-> {target_of(staging)}) — delete it; the harness writes its "
            "atomic-write sibling there and will not follow a link",
            1,
        )
    if staging.exists() and not staging.is_file():
        raise HarnessError(
            f"{what}: the staging path {staging} is occupied by something that "
            "is not a regular file — remove it, then re-run the command",
            1,
        )


def audit_problems(
    root: Path, strict: list[str], followable: list[str] | tuple[str, ...] = (),
) -> list[tuple[str, str | None]]:
    """doctor's checks: managed paths that are links, and leftover siblings.

    Reported rather than repaired: an operator learns here instead of when a
    write refuses, and the line says whether the target escapes the project.
    Asked per path, because the write policy answers it per path. A `strict`
    path refuses every link. A `followable` path is written THROUGH the link
    by `write_target`, so only an escaping target is a failure there — the one
    case that write refuses. Both directions matter: reporting the supported
    convention as broken sends operators to repair a working install, and
    staying silent about the escaping one hides data destruction.
    """
    linked: list[str] = []
    litter: list[str] = []
    for rel, follows in [*((r, False) for r in strict),
                         *((r, True) for r in followable)]:
        path = root / rel
        target = target_of(path)
        if target is not None and not inside(target, root):
            linked.append(f"{rel} -> {target} (OUTSIDE the project)")
        elif target is None and not inside(path.resolve(), root):
            # No link at the leaf, but the path still leaves the project: a
            # parent directory is the link. Same damage, reported the same way.
            linked.append(f"{rel} -> {path.resolve()} (OUTSIDE the project, "
                          "via a symlinked parent directory)")
        elif target is not None and not follows:
            linked.append(f"{rel} -> {target} (inside the project)")
        # fileio stages beside the file it writes: for a followable path that
        # is the TARGET, not the link.
        staged = (target if follows and target is not None
                  and inside(target, root) else path)
        sibling = staged.with_name(staged.name + ATOMIC_SUFFIX)
        if sibling.exists() or sibling.is_symlink():
            litter.append(sibling.relative_to(root).as_posix())
    return [
        ("managed paths are regular files",
         "symlinked: " + "; ".join(linked) +
         " — the harness refuses to write these; point them at regular files "
         "or edit the targets directly" if linked else None),
        ("no leftover staging siblings",
         "found: " + ", ".join(litter) +
         " — left by an interrupted write; inspect and delete them"
         if litter else None),
    ]
