# Evaluation contract — nanoclaw

Define success criteria per goal, at goal start (PROCESS.md step 1). Honest criteria are properties of the goal, not defaults baked into this file. This file holds how to phrase them, the standing verification commands for nanoclaw, and the rubric the reviewer scores against.

## Phrase measurable criteria

- Write each criterion as a check that passes or fails — a command with an expected exit code, an observable behavior with concrete inputs and outputs — never as a vague quality such as "clean" or "robust".
- Include at least one criterion that exercises the product the way a user would, not only unit-level checks.
- Record the criteria in the run journal verbatim before building; do not revise them mid-goal to fit what was built.

## Standing verification commands

The session that installs the harness fills this list in for nanoclaw: build, test, lint, and end-to-end commands, each with its expected outcome. Every goal runs them in PROCESS.md step 4 and captures raw output into the journal.

- (none recorded — the installing session, or the first goal, adds them here)

## Reviewer rubric

Score every goal on these four lines, each pass or fail with one sentence of evidence from what was actually run:

- Works — the product does what the goal claims, demonstrated by running it.
- Usable — a user can use the result without insider knowledge.
- Meets criteria — every criterion recorded at goal start passes as written.
- Regressions — nothing that worked before the goal is worse now.
