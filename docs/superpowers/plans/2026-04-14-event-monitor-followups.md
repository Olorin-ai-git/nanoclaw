# Event Monitor System — Deferred Follow-ups

**Goal:** Work through the non-blocking items flagged during the 2026-04-13 event-monitor deployment. Each task is independent and small. All should land on a single feature branch with 437+ tests still green. LinkedIn real fetch implementation is explicitly deferred to a separate future task (out of scope).

**Working directory:** `/Users/olorin/nanoclaw`
**Branch plan:** `feature/event-monitor-followups` off `main`.

---

## T1 — Monitor-store split: `updateSeenIds`

**Why:** Four monitors currently abuse `updateAfterWake(name, ts, '', ids)` just to persist dedup ids during `check()`. The runner then re-reads state and calls `updateAfterWake` properly with the real hash. Overloading `updateAfterWake` for "seen-ids only" writes is fragile — a monitor forgetting the empty-hash contract could overwrite `last_wake`/`last_data_hash`.

**Files:**

- Modify: `src/monitor-store.ts` — add `updateSeenIds(name, ids)` (caps at 500, writes only `seen_ids`).
- Modify: `src/monitor-store.test.ts` — 2 new tests: (a) writes only `seen_ids` column, leaving `last_wake`/`last_data_hash`/`last_run` untouched; (b) caps at 500.
- Modify: `monitors/reddit-keywords.ts` — replace `updateAfterWake(config.name, new Date().toISOString(), '', allIds)` with `updateSeenIds(config.name, allIds)`.
- Modify: `monitors/prospect-pipeline.ts` — same replacement.
- Modify: `monitors/competitor-alerts.ts` — same replacement.
- Modify: `monitors/email-responses.ts` — same replacement.

**Verification:** Existing `monitor-runner.test.ts` "re-read state so monitor's seen_ids survive" case must still pass — the runner reads from `monitor_state` regardless of which helper wrote it.

---

## T2 — Unit tests for `parseRss` and `parseProspectsFile`

**Why:** Both are pure, deterministic string-parsing helpers — trivially testable and the kind of code that rots silently when feed formats drift.

**Files:**

- Modify: `monitors/competitor-alerts.ts` — change `function parseRss` → `export function parseRss`.
- Modify: `monitors/prospect-pipeline.ts` — change `function parseProspectsFile` → `export function parseProspectsFile`.
- Modify: `vitest.config.ts` — extend `include` with `'monitors/**/*.test.ts'`.
- Create: `monitors/competitor-alerts.test.ts` — cases:
  - well-formed RSS with 3 items + CDATA titles
  - items with missing `<link>`/`<guid>` (falls back to title)
  - malformed XML returns `[]`
  - Atom feed (`<feed>…<entry>`) returns `[]` and triggers debug log (just assert `[]`; no log coupling needed)
  - pubDate parse: invalid date string falls back to `new Date().toISOString()`
- Create: `monitors/prospect-pipeline.test.ts` — cases:
  - bulleted list with email per line, mix of sent/unsent markers
  - lines without email ignored
  - lines without leading `-`/`*`/`|` ignored
  - `|` table rows counted
  - `sent on 2026-01-05` style date extracted; latest date wins across multiple lines
  - empty file / only whitespace → zero counts

**Verification:** `npm test` picks up the new files (after vitest include change) and all pass.

---

## T3 — Per-fetch timeouts

**Why:** Runner's 30s `CHECK_TIMEOUT_MS` is a whole-check timeout; a single slow fetch can eat the entire budget. `AbortSignal.timeout(25_000)` on each fetch is defense-in-depth.

**Files:**

- Modify: `monitors/reddit-keywords.ts` — add `const FETCH_TIMEOUT_MS = 25_000;` near the other constants; `fetch(FEED_URL, { …, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })`.
- Modify: `monitors/email-responses.ts` — same pattern on the Resend fetch.
- Modify: `monitors/competitor-alerts.ts` — same pattern inside `fetchFeed`.

**Verification:** `npm run build` + `npm test`. No new tests (timeout behavior is hard to unit-test without fake timers and non-value-adding for one-line wiring).

---

## T4 — Keyword lists in `monitors/config.json`

**Why:** Three monitors have hard-coded keyword arrays (`reddit-keywords`, `competitor-alerts`, `linkedin-engagement`). Moving them to JSON enables non-code tuning without redeploy.

**Design:**

- Per-monitor override shape already accepts `Partial<MonitorConfig>`. Broaden to also carry monitor-specific keyword arrays via typed extension fields.
- Add `keywords?: string[]` and `buyingSignals?: string[]` to a new interface `MonitorConfigExtras` merged into `MonitorConfig` as `extras?`.
- Runner's `mergeMonitorConfig` preserves `extras` from the override.
- Expose a helper `getLoadedGlobalConfig()` on `monitor-runner.ts` that returns the last-loaded global config (cached at `loadMonitorConfig` call). Each monitor reads `getLoadedGlobalConfig()?.monitors[name]?.extras?.keywords ?? FALLBACK_KEYWORDS`.
- FALLBACK arrays stay in each monitor file so the code never relies on the JSON being populated.

**Files:**

- Modify: `src/monitor-types.ts` — add:
  ```ts
  export interface MonitorConfigExtras {
    keywords?: string[];
    buyingSignals?: string[];
  }
  export interface MonitorConfig { …; extras?: MonitorConfigExtras; }
  export interface MonitorGlobalConfig { …
    monitors: Record<string, Partial<MonitorConfig>>; // unchanged shape; extras flow through
  }
  ```
- Modify: `src/monitor-runner.ts`:
  - Cache `loadedGlobal: MonitorGlobalConfig | null = null` inside the module; `loadMonitorConfig` updates it.
  - Export `getLoadedGlobalConfig(): MonitorGlobalConfig | null`.
  - `mergeMonitorConfig` already spreads `...override` — verify `extras` flows; no change expected.
- Modify: `monitors/config.json` — add `"extras": { "keywords": […] }` under `reddit-keywords` and `competitor-alerts`, and `"extras": { "buyingSignals": […] }` under `linkedin-engagement`. Preserve the defaults currently hardcoded in each file.
- Modify: `monitors/reddit-keywords.ts` — rename constant `KEYWORDS` → `FALLBACK_KEYWORDS`; at top of `check()` resolve `const keywords = getLoadedGlobalConfig()?.monitors[config.name]?.extras?.keywords ?? FALLBACK_KEYWORDS;`.
- Modify: `monitors/competitor-alerts.ts` — same pattern.
- Modify: `monitors/linkedin-engagement.ts` — same pattern but for `buyingSignals`.
- Modify: `src/monitor-runner.test.ts` — add one test: when global config has `extras.keywords`, `getLoadedGlobalConfig()` returns it.

**Verification:** `npm test`; manually `scripts/claw --monitor reddit-keywords --run-now` with and without a `monitors/config.json` containing overridden keywords.

---

## T5 — Insertion-time guard on `__monitor__:` sender

**Why:** The trigger-bypass rule `sender.startsWith('__monitor__:')` trusts that no channel ever produces such a sender. Single-tenant today, but a schema-level CHECK would block legitimate injection. Cleaner: a dedicated `storeMonitorMessage` helper for injection, and a runtime assertion in `storeMessage` that rejects `__monitor__:` senders so no other code path accidentally produces one.

**Files:**

- Modify: `src/db.ts` —
  - Add `export function storeMonitorMessage(msg: NewMessage): void` that runs the same INSERT as `storeMessage` (no check) and asserts the sender DOES start with `__monitor__:`.
  - Add a guard at the top of `storeMessage` and `storeMessageDirect`: `if (msg.sender.startsWith('__monitor__:')) throw new Error('storeMessage: refusing to write __monitor__: sender; use storeMonitorMessage');`
- Modify: `src/monitor-runner.ts` — swap `storeMessage(msg)` → `storeMonitorMessage(msg)` in `injectMonitorMessage`.
- Modify: `src/monitor-runner.test.ts` — verify the existing "monitor injects a message" test still passes (runner uses the new helper).
- Add 2 tests to an existing db test file OR `src/monitor-trigger-bypass.test.ts` (already exists): (a) `storeMessage` throws when sender has the monitor prefix; (b) `storeMonitorMessage` succeeds and the row is visible to `getNewMessages`.

**Verification:** Full test suite still 100% green.

---

## T6 — Plan-document typos

**Why:** The 2026-04-13 plan still claims `../../monitors/index.js` (wrong — actual code uses `../monitors/index.js`), test counts ("13 tests"/"12 tests" → actually 15/14), and an older `withTimeout` shape. Non-blocking but misleading for anyone re-reading the plan.

**Files:**

- Modify: `docs/superpowers/plans/2026-04-13-event-monitor-system.md`:
  - Lines ~2217–2240: replace all `../../monitors/index.js` with `../monitors/index.js` and update the path-resolution note accordingly.
  - Line ~974: `13 tests` → `15 tests`.
  - Line ~1981: `12 tests` → `14 tests`.
  - Lines ~1613+: update the `withTimeout` code block to match the shipped discriminated-union version in `src/monitor-runner.ts`.

**Verification:** Visual diff; no build impact.

---

## T7 — Cosmetic cleanup

**Why:** Small hygiene items from the 2026-04-13 review.

**T7a: Remove `_resetMonitorLoopForTests`**

- Grep confirms: only used by the monitor-runner file itself (no test calls it).
- Delete the function and the `monitorLoopRunning` / `scheduledTimers` / `staggerTimers` cleanup pattern is fine to keep (live code) — just drop the dead reset export.

**T7b: Deterministic stagger**

- Replace `Math.random()` in `startMonitorLoop` with a hash-based deterministic offset from `crypto.createHash('sha1').update(name).digest()` → read 2 bytes → modulo 15_000 → add 5_000. Same monitor name always staggers to the same offset; different names spread across the 5–20s window.
- No test is required (this is startup behavior), but `monitor-runner.test.ts` shouldn't break.

**Files:**

- Modify: `src/monitor-runner.ts` — delete `_resetMonitorLoopForTests`; replace `Math.random()` stagger with hash-based offset.

**Verification:** `npm run build`, `npm test`. Start the service locally (`npm run dev`) briefly — confirm all 5 monitors still schedule and first-fire within the 5–20s window per log output.

---

## Execution order

Independent tasks — but T1 touches the same 4 monitor files as T3 and T4, so ordering matters for clean diffs:

1. **T6** (plan doc typos) — pure docs, commit and forget.
2. **T7** (cosmetic) — isolated `monitor-runner.ts` change.
3. **T1** (updateSeenIds) — store + 4 monitor files.
4. **T3** (fetch timeouts) — same 3 fetch-using monitors.
5. **T5** (sender guard) — db + runner + tests.
6. **T4** (keywords in config) — touches the 3 keyword-using monitors last.
7. **T2** (parseRss/parseProspectsFile tests) — last since test-only.

Each task is its own commit. After all 7: run `npm run build`, `npm test`, `npm run lint`, rebase onto `main`, open PR, merge, deploy.

## Out of scope

- **LinkedIn real fetch implementation** — deferred to a separate future task per the 2026-04-13 resumption context.
- **Group-routing or channel-level changes** — no monitor behavior change except the local refactors above.

## File-level summary

| File                                                        | T1  | T2           | T3  | T4  | T5  | T6  | T7  |
| ----------------------------------------------------------- | --- | ------------ | --- | --- | --- | --- | --- |
| `src/monitor-store.ts`                                      | mod |              |     |     |     |     |     |
| `src/monitor-store.test.ts`                                 | mod |              |     |     |     |     |     |
| `src/monitor-runner.ts`                                     |     |              |     | mod | mod |     | mod |
| `src/monitor-runner.test.ts`                                |     |              |     | mod | mod |     |     |
| `src/monitor-trigger-bypass.test.ts`                        |     |              |     |     | mod |     |     |
| `src/monitor-types.ts`                                      |     |              |     | mod |     |     |     |
| `src/db.ts`                                                 |     |              |     |     | mod |     |     |
| `monitors/reddit-keywords.ts`                               | mod |              | mod | mod |     |     |     |
| `monitors/prospect-pipeline.ts`                             | mod |              |     |     |     |     |     |
| `monitors/competitor-alerts.ts`                             | mod | mod (export) | mod | mod |     |     |     |
| `monitors/email-responses.ts`                               | mod |              | mod |     |     |     |     |
| `monitors/linkedin-engagement.ts`                           |     |              |     | mod |     |     |     |
| `monitors/config.json`                                      |     |              |     | mod |     |     |     |
| `monitors/competitor-alerts.test.ts`                        |     | new          |     |     |     |     |     |
| `monitors/prospect-pipeline.test.ts`                        |     | new          |     |     |     |     |     |
| `vitest.config.ts`                                          |     | mod          |     |     |     |     |     |
| `docs/superpowers/plans/2026-04-13-event-monitor-system.md` |     |              |     |     |     | mod |     |
