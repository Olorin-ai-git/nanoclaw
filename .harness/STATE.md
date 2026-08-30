# Harness state

No active goal.

When a goal starts (PROCESS.md step 1), replace the line above with the path of the active run journal under `.harness/runs/` and the current PROCESS.md step, so any fresh session finds where things stand in one read. Write the step as `PROCESS step <n>` (`PROCESS.md step <n>` and `PROCESS step: <n>` also read correctly) so the dashboard dial can light it — for example: `Active: .harness/runs/2026-08-09-my-goal.md — PROCESS step 3 (Build).` Clear it back to `No active goal.` in SELF-IMPROVE.md step 6. The journal itself is the durable state; this file is only the pointer.
