# Goal loop

<!-- harness:core:begin -->

This loop applies to goal-scale work: explicit goals, features, and multi-step fixes that end in a completion claim. Questions, investigations, and single-edit changes are exempt.

0. **Sync** — run `.harness/bin/harness status`. If any unit is stale, run `.harness/bin/harness update`. If the update conflicts, resolve the conflict in the named file, run `.harness/bin/harness resolve <unit-id>`, then `.harness/bin/harness doctor` — that is the first task of the session, before the goal. If the canonical home is unreachable, note it in the run journal and proceed; the inner loop never blocks on it. Read PROCESS.md, LEARNINGS.md (both sections), SELF-IMPROVE.md, and EVALS.md before any work.
1. **Frame** — create `.harness/runs/<date>-<slug>.md`. Record the goal verbatim and measurable success criteria phrased per EVALS.md. Point STATE.md at the run journal.
2. **Plan** — write the plan to a file: the project's planning convention if one exists, else the run journal. List the existing infrastructure the plan reuses rather than rebuilds.
3. **Build** — follow project conventions. Keep the journal's state section current so an interrupted session can resume from it. For goals that decompose into independent subtasks, run them as parallel agent loops in isolated git worktrees — use `superpowers:using-git-worktrees` where available, plain `git worktree` otherwise — one loop per worktree, never two loops in one checkout.
4. **Verify** — run the verification commands from EVALS.md; capture real output into the journal, raw, with exit codes, each log opening with the command and the repo HEAD it ran against — evidence that trails the tree is re-run, never restamped. Unit tests are necessary but not sufficient: exercise the product the way a user would before calling it working. A verification that manufactures findings is as broken as one that hides them: when a check fires, confirm the difference is real before acting on it. Where a goal has several required halves, report per target which halves hold and count a target done only when all of them do, naming the blocker for each that is missing.
5. **Review** — run the project's own mandated review convention where one exists (in the olorin monorepo: the CLAUDE.md Quality Gates panel with base/head SHAs), **and** dispatch the `harness-reviewer` subagent for the product-usage evaluation a code panel does not do — on the model named by `review.model` in `.harness/harness.json` when set, so builder and reviewer are different models. Where no convention exists, harness-reviewer alone. Where subagent dispatch is unavailable, follow `.claude/agents/harness-reviewer.md` as a checklist inline and say so in the journal. harness-reviewer complements a repo's review gate; it never replaces it.
6. **Audit** — adversarial pass: the `adversarial-audit` skill where available, else the `harness-auditor` subagent, else its file followed inline — the journal says which ran. When any gate finds a defect, fix the defect's class across the whole surface, not the single instance. Re-derive every exemption and safety rationale written under the old rule before calling the class closed. When the gate cannot finish — a quota, an outage, a refused permission — say so and triage its output by hand rather than reporting the unfinished gate as passed.
7. **Gate** — where a judge skill (`judge-with-codex`) is available, run it and only declare the goal done on green. Otherwise the audit in step 6 is the final gate; the journal must say so, and must note that builder and evaluator were the same model.
8. **Ship** — integrate via the project's push convention: `git push no-mistakes` / the no-mistakes skill where present, the repo's documented flow otherwise. Record the PR or commit in the journal.
9. **Self-improve** — follow SELF-IMPROVE.md in full. This step is part of the goal; the goal is not done until it has run.
<!-- harness:core:end -->

## Project extensions

<!-- harness:project:begin -->

(Project-specific process additions live here and never leave this project.)

<!-- harness:project:end -->
