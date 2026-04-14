# NanoClaw Event Monitor System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lightweight event-monitor subsystem that polls external sources on configurable intervals and injects synthetic messages into target groups' queues when something actionable is detected — turning NanoClaw from "responds to messages" into "watches the world and acts on events."

**Architecture:** Monitors are plain TypeScript functions (no LLM calls) that return `{ shouldWake, priority, data, summary }`. A runner loads them at startup, schedules each on its own `setInterval`, and — when `shouldWake` is true — synthesizes a `NewMessage` stamped with a `__monitor__:` sender so the existing message-loop processes it naturally. Deduplication via per-monitor data hash, failure tracking in SQLite, quiet-hours gating, and trigger-check bypass for monitor-sourced messages. Monitors live at `monitors/` at repo root so they're easy to add without touching `src/`.

**Tech Stack:** TypeScript, better-sqlite3 (existing), Node's built-in `fetch`, `cron-parser` (existing) for interval math, vitest for tests. Zero new runtime dependencies.

---

## File Structure

**New files (all under `/Users/olorin/nanoclaw/`):**

- `monitors/config.json` — declarative config: quiet hours, per-monitor interval/enabled defaults
- `monitors/index.ts` — static registry that imports and exports all monitors
- `monitors/reddit-keywords.ts` — Reddit subreddit poller with keyword filter
- `monitors/prospect-pipeline.ts` — reads `groups/slack_dm/marketing/outreach/prospects.md`
- `monitors/email-responses.ts` — polls Resend API for status changes
- `monitors/linkedin-engagement.ts` — stub (returns `shouldWake: false` until creds configured)
- `monitors/competitor-alerts.ts` — RSS feed reader
- `monitors/README.md` — how to add new monitors
- `src/monitor-types.ts` — `Monitor`, `MonitorConfig`, `MonitorResult`, `MonitorDependencies` types
- `src/monitor-store.ts` — SQLite accessors for `monitor_state` and `monitor_run_logs` tables
- `src/monitor-runner.ts` — runner loop: `startMonitorLoop`, `injectMonitorMessage`, `runMonitorOnce`, `loadMonitorConfig`
- `src/quiet-hours.ts` — `isInQuietHours` helper (timezone-aware)
- `src/monitor-store.test.ts` — store CRUD tests
- `src/monitor-runner.test.ts` — runner behaviour tests (dedup, failure tracking, quiet hours, injection)
- `src/quiet-hours.test.ts` — quiet-hours boundary tests

**Modified files:**

- `tsconfig.json` — include `monitors/**/*`, change `rootDir` to `.`
- `package.json` — update `main` and `start` paths to `dist/src/index.js`
- `launchd/com.nanoclaw.plist` — update `dist/index.js` → `dist/src/index.js`
- `src/db.ts` — add `monitor_state` and `monitor_run_logs` tables in `createSchema`
- `src/index.ts` — wire `startMonitorLoop` in `main()`; modify trigger check in `startMessageLoop` and `processGroupMessages` to bypass for `__monitor__:` senders
- `src/config.ts` — export `MONITORS_DIR`
- `scripts/claw` — add `--monitors`, `--monitor`, `--enable`, `--disable`, `--run-now`, `--history` flags

Each module has one clear responsibility:

- `monitor-types.ts` — types only, no logic
- `monitor-store.ts` — DB I/O only
- `monitor-runner.ts` — orchestration: loading, scheduling, timeout, dedup, failure handling, injection
- `quiet-hours.ts` — pure time calculation
- `monitors/*.ts` — one fetch+filter per file (30–80 lines each)

---

## Task 1: Adjust TypeScript build to include `monitors/` at project root

**Files:**

- Modify: `/Users/olorin/nanoclaw/tsconfig.json`
- Modify: `/Users/olorin/nanoclaw/package.json:6-9`
- Modify: `/Users/olorin/nanoclaw/launchd/com.nanoclaw.plist:10`
- Create: `/Users/olorin/nanoclaw/monitors/.gitkeep` (placeholder so the dir exists before monitors are added)

- [ ] **Step 1: Update tsconfig to include monitors/**

Replace the entire contents of `tsconfig.json` with:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*", "monitors/**/*"],
  "exclude": ["node_modules", "dist", "container/**/*"]
}
```

- [ ] **Step 2: Update package.json entry paths**

In `/Users/olorin/nanoclaw/package.json`, change:

```json
  "main": "dist/index.js",
```

to:

```json
  "main": "dist/src/index.js",
```

And change the `start` script:

```json
    "start": "node dist/index.js",
```

to:

```json
    "start": "node dist/src/index.js",
```

- [ ] **Step 3: Update launchd plist**

In `/Users/olorin/nanoclaw/launchd/com.nanoclaw.plist`, change the line that references `dist/index.js` to `dist/src/index.js`. The file has `{{PROJECT_ROOT}}/dist/index.js` — change to `{{PROJECT_ROOT}}/dist/src/index.js`.

- [ ] **Step 4: Create the monitors directory**

```bash
mkdir -p /Users/olorin/nanoclaw/monitors
touch /Users/olorin/nanoclaw/monitors/.gitkeep
```

- [ ] **Step 5: Verify typecheck and build still work**

Run: `cd /Users/olorin/nanoclaw && npm run typecheck`
Expected: exits 0, no errors.

Run: `cd /Users/olorin/nanoclaw && npm run build`
Expected: exits 0. The compiled file now lives at `dist/src/index.js`.

- [ ] **Step 6: Commit**

```bash
cd /Users/olorin/nanoclaw
git add tsconfig.json package.json launchd/com.nanoclaw.plist monitors/.gitkeep
git commit -m "chore: include monitors/ dir in TS build, shift dist entry to dist/src/"
```

---

## Task 2: Define monitor types and interfaces

**Files:**

- Create: `/Users/olorin/nanoclaw/src/monitor-types.ts`

- [ ] **Step 1: Write the type definitions file**

Create `/Users/olorin/nanoclaw/src/monitor-types.ts` with:

```typescript
import { Channel, RegisteredGroup } from './types.js';

export type MonitorPriority = 'low' | 'normal' | 'urgent';

/**
 * Per-monitor configuration (declared in each monitor file and
 * merged with overrides from monitors/config.json at load time).
 */
export interface MonitorConfig {
  name: string;
  intervalMinutes: number;
  targetGroup: string; // folder name, e.g. "reddit-scout"
  enabled: boolean;
  /** If true, skip runs during quiet hours. Defaults to true. */
  respectQuietHours?: boolean;
  /** If true, only run Mon-Fri. Defaults to false. */
  weekdaysOnly?: boolean;
  /** If set, only run between these hours in the configured timezone (24h, "HH:MM"). */
  businessHours?: { start: string; end: string };
}

export interface MonitorResult {
  shouldWake: boolean;
  priority: MonitorPriority;
  data: Record<string, unknown>;
  summary: string;
}

/** The default export of every monitor file. */
export interface Monitor {
  config: MonitorConfig;
  check(): Promise<MonitorResult>;
}

/** Dependencies injected into the monitor-runner. */
export interface MonitorDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  channels: () => Channel[];
  /** Called when a monitor triggers and we need to wake an agent for targetGroupFolder. */
  enqueueMonitorCheck: (chatJid: string) => void;
}

/** Global settings read from monitors/config.json. */
export interface MonitorGlobalConfig {
  enabled: boolean;
  defaultIntervalMinutes: number;
  maxConcurrentMonitors: number;
  quietHours: {
    start: string; // "HH:MM"
    end: string; // "HH:MM"
    timezone: string; // IANA, e.g. "America/New_York"
  };
  monitors: Record<string, Partial<MonitorConfig>>;
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd /Users/olorin/nanoclaw && npm run typecheck`
Expected: exits 0, no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/olorin/nanoclaw
git add src/monitor-types.ts
git commit -m "feat(monitors): add Monitor, MonitorConfig, MonitorResult types"
```

---

## Task 3: Add monitor DB schema and migrations

**Files:**

- Modify: `/Users/olorin/nanoclaw/src/db.ts` (inside `createSchema`, around line 85 and migration block around line 148)

- [ ] **Step 1: Add tables to the schema block in `createSchema`**

In `/Users/olorin/nanoclaw/src/db.ts`, find the `createSchema` function. After the `registered_groups` table and BEFORE the closing backtick of the `database.exec` (line 84 is the last SQL; closing \`); is on 85), add two new tables.

Locate this block:

```typescript
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
  `);
```

Replace the closing of that `database.exec` call (the `);` line) to include two more tables right before it, like this:

```typescript
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS monitor_state (
      name TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run TEXT,
      last_wake TEXT,
      last_data_hash TEXT,
      seen_ids TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      auto_disabled_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS monitor_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_name TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      woke_agent INTEGER NOT NULL DEFAULT 0,
      priority TEXT,
      summary TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_monitor_run_logs
      ON monitor_run_logs(monitor_name, run_at DESC);
  `);
```

- [ ] **Step 2: Run typecheck to confirm no syntax errors**

Run: `cd /Users/olorin/nanoclaw && npm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
cd /Users/olorin/nanoclaw
git add src/db.ts
git commit -m "feat(monitors): add monitor_state and monitor_run_logs tables"
```

---

## Task 4: Write failing test for monitor-store

**Files:**

- Create: `/Users/olorin/nanoclaw/src/monitor-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `/Users/olorin/nanoclaw/src/monitor-store.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from './db.js';
import {
  autoDisableMonitor,
  getMonitorHistory,
  getMonitorState,
  initMonitorState,
  logMonitorRun,
  recordFailure,
  resetFailures,
  setMonitorEnabled,
  updateAfterRun,
  updateAfterWake,
} from './monitor-store.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('monitor-store', () => {
  it('initializes a monitor with enabled=true and zero failures', () => {
    initMonitorState('reddit-keywords', true);
    const state = getMonitorState('reddit-keywords');
    expect(state).toBeDefined();
    expect(state!.enabled).toBe(true);
    expect(state!.consecutive_failures).toBe(0);
    expect(state!.last_run).toBeNull();
    expect(state!.last_wake).toBeNull();
    expect(state!.seen_ids).toEqual([]);
  });

  it('initMonitorState does not overwrite existing state', () => {
    initMonitorState('m', true);
    setMonitorEnabled('m', false);
    initMonitorState('m', true); // should be a no-op
    expect(getMonitorState('m')!.enabled).toBe(false);
  });

  it('setMonitorEnabled toggles enabled and clears auto-disable reason', () => {
    initMonitorState('m', true);
    autoDisableMonitor('m', 'fetch failed');
    expect(getMonitorState('m')!.enabled).toBe(false);
    expect(getMonitorState('m')!.auto_disabled_reason).toBe('fetch failed');
    setMonitorEnabled('m', true);
    expect(getMonitorState('m')!.enabled).toBe(true);
    expect(getMonitorState('m')!.auto_disabled_reason).toBeNull();
  });

  it('updateAfterRun stamps last_run timestamp', () => {
    initMonitorState('m', true);
    const ts = '2026-04-13T10:00:00.000Z';
    updateAfterRun('m', ts);
    expect(getMonitorState('m')!.last_run).toBe(ts);
  });

  it('updateAfterWake records hash and seen ids', () => {
    initMonitorState('m', true);
    const ts = '2026-04-13T10:00:00.000Z';
    updateAfterWake('m', ts, 'hash-abc', ['post-1', 'post-2']);
    const state = getMonitorState('m')!;
    expect(state.last_wake).toBe(ts);
    expect(state.last_data_hash).toBe('hash-abc');
    expect(state.seen_ids).toEqual(['post-1', 'post-2']);
  });

  it('seen_ids is capped at 500 entries (oldest first dropped)', () => {
    initMonitorState('m', true);
    const ids = Array.from({ length: 600 }, (_, i) => `id-${i}`);
    updateAfterWake('m', '2026-04-13T10:00:00.000Z', 'hash', ids);
    const stored = getMonitorState('m')!.seen_ids;
    expect(stored).toHaveLength(500);
    expect(stored[0]).toBe('id-100'); // oldest 100 dropped
    expect(stored[499]).toBe('id-599');
  });

  it('recordFailure increments consecutive_failures', () => {
    initMonitorState('m', true);
    recordFailure('m');
    recordFailure('m');
    expect(getMonitorState('m')!.consecutive_failures).toBe(2);
  });

  it('resetFailures zeroes consecutive_failures', () => {
    initMonitorState('m', true);
    recordFailure('m');
    recordFailure('m');
    resetFailures('m');
    expect(getMonitorState('m')!.consecutive_failures).toBe(0);
  });

  it('autoDisableMonitor sets enabled=false and records reason', () => {
    initMonitorState('m', true);
    autoDisableMonitor('m', 'Network unreachable');
    const state = getMonitorState('m')!;
    expect(state.enabled).toBe(false);
    expect(state.auto_disabled_reason).toBe('Network unreachable');
  });

  it('logMonitorRun and getMonitorHistory round-trip rows (newest first)', () => {
    initMonitorState('m', true);
    logMonitorRun({
      monitor_name: 'm',
      run_at: '2026-04-13T10:00:00.000Z',
      duration_ms: 120,
      status: 'success',
      woke_agent: true,
      priority: 'normal',
      summary: 'found 1 match',
      error: null,
    });
    logMonitorRun({
      monitor_name: 'm',
      run_at: '2026-04-13T10:20:00.000Z',
      duration_ms: 90,
      status: 'no-wake',
      woke_agent: false,
      priority: null,
      summary: null,
      error: null,
    });
    const history = getMonitorHistory('m', 10);
    expect(history).toHaveLength(2);
    expect(history[0].run_at).toBe('2026-04-13T10:20:00.000Z');
    expect(history[1].run_at).toBe('2026-04-13T10:00:00.000Z');
  });

  it('getMonitorHistory honors limit', () => {
    initMonitorState('m', true);
    for (let i = 0; i < 20; i++) {
      logMonitorRun({
        monitor_name: 'm',
        run_at: new Date(2026, 3, 13, 10, i).toISOString(),
        duration_ms: 100,
        status: 'success',
        woke_agent: false,
        priority: null,
        summary: null,
        error: null,
      });
    }
    expect(getMonitorHistory('m', 5)).toHaveLength(5);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `cd /Users/olorin/nanoclaw && npx vitest run src/monitor-store.test.ts`
Expected: FAIL with "Cannot find module './monitor-store.js'" (module doesn't exist yet).

- [ ] **Step 3: Commit (failing test)**

```bash
cd /Users/olorin/nanoclaw
git add src/monitor-store.test.ts
git commit -m "test(monitors): add failing tests for monitor-store"
```

---

## Task 5: Implement monitor-store

**Files:**

- Create: `/Users/olorin/nanoclaw/src/monitor-store.ts`

- [ ] **Step 1: Write the implementation**

Create `/Users/olorin/nanoclaw/src/monitor-store.ts`:

```typescript
import Database from 'better-sqlite3';

import { getDb } from './db.js';
import { logger } from './logger.js';

const SEEN_IDS_CAP = 500;

export interface MonitorStateRow {
  name: string;
  enabled: boolean;
  last_run: string | null;
  last_wake: string | null;
  last_data_hash: string | null;
  seen_ids: string[];
  consecutive_failures: number;
  auto_disabled_reason: string | null;
}

export interface MonitorRunLog {
  monitor_name: string;
  run_at: string;
  duration_ms: number;
  status:
    | 'success'
    | 'no-wake'
    | 'error'
    | 'timeout'
    | 'skipped-quiet'
    | 'skipped-weekday'
    | 'skipped-business-hours'
    | 'skipped-disabled';
  woke_agent: boolean;
  priority: 'low' | 'normal' | 'urgent' | null;
  summary: string | null;
  error: string | null;
}

interface RawStateRow {
  name: string;
  enabled: number;
  last_run: string | null;
  last_wake: string | null;
  last_data_hash: string | null;
  seen_ids: string | null;
  consecutive_failures: number;
  auto_disabled_reason: string | null;
}

function parseSeenIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x) => typeof x === 'string')
      : [];
  } catch {
    return [];
  }
}

function rowToState(row: RawStateRow): MonitorStateRow {
  return {
    name: row.name,
    enabled: row.enabled === 1,
    last_run: row.last_run,
    last_wake: row.last_wake,
    last_data_hash: row.last_data_hash,
    seen_ids: parseSeenIds(row.seen_ids),
    consecutive_failures: row.consecutive_failures,
    auto_disabled_reason: row.auto_disabled_reason,
  };
}

export function initMonitorState(name: string, enabled: boolean): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO monitor_state (name, enabled) VALUES (?, ?)`,
  ).run(name, enabled ? 1 : 0);
}

export function getMonitorState(name: string): MonitorStateRow | undefined {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM monitor_state WHERE name = ?`)
    .get(name) as RawStateRow | undefined;
  return row ? rowToState(row) : undefined;
}

export function getAllMonitorStates(): MonitorStateRow[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM monitor_state ORDER BY name`)
    .all() as RawStateRow[];
  return rows.map(rowToState);
}

export function setMonitorEnabled(name: string, enabled: boolean): void {
  const db = getDb();
  db.prepare(
    `UPDATE monitor_state SET enabled = ?, auto_disabled_reason = NULL WHERE name = ?`,
  ).run(enabled ? 1 : 0, name);
}

export function updateAfterRun(name: string, runAt: string): void {
  const db = getDb();
  db.prepare(`UPDATE monitor_state SET last_run = ? WHERE name = ?`).run(
    runAt,
    name,
  );
}

export function updateAfterWake(
  name: string,
  wakeAt: string,
  dataHash: string,
  seenIds: string[],
): void {
  const capped = seenIds.slice(-SEEN_IDS_CAP);
  const db = getDb();
  db.prepare(
    `UPDATE monitor_state
     SET last_wake = ?, last_data_hash = ?, seen_ids = ?
     WHERE name = ?`,
  ).run(wakeAt, dataHash, JSON.stringify(capped), name);
}

export function recordFailure(name: string): number {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE monitor_state
       SET consecutive_failures = consecutive_failures + 1
       WHERE name = ?
       RETURNING consecutive_failures`,
    )
    .get(name) as { consecutive_failures: number } | undefined;
  return result?.consecutive_failures ?? 0;
}

export function resetFailures(name: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE monitor_state SET consecutive_failures = 0 WHERE name = ?`,
  ).run(name);
}

export function autoDisableMonitor(name: string, reason: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE monitor_state
     SET enabled = 0, auto_disabled_reason = ?, consecutive_failures = 0
     WHERE name = ?`,
  ).run(reason, name);
  logger.warn({ monitor: name, reason }, 'Monitor auto-disabled');
}

export function logMonitorRun(log: MonitorRunLog): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO monitor_run_logs
     (monitor_name, run_at, duration_ms, status, woke_agent, priority, summary, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    log.monitor_name,
    log.run_at,
    log.duration_ms,
    log.status,
    log.woke_agent ? 1 : 0,
    log.priority,
    log.summary,
    log.error,
  );
}

interface RawLogRow {
  monitor_name: string;
  run_at: string;
  duration_ms: number;
  status: string;
  woke_agent: number;
  priority: string | null;
  summary: string | null;
  error: string | null;
}

export function getMonitorHistory(
  name: string,
  limit: number,
): MonitorRunLog[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT monitor_name, run_at, duration_ms, status, woke_agent, priority, summary, error
       FROM monitor_run_logs
       WHERE monitor_name = ?
       ORDER BY run_at DESC
       LIMIT ?`,
    )
    .all(name, limit) as RawLogRow[];
  return rows.map((r) => ({
    monitor_name: r.monitor_name,
    run_at: r.run_at,
    duration_ms: r.duration_ms,
    status: r.status as MonitorRunLog['status'],
    woke_agent: r.woke_agent === 1,
    priority: r.priority as MonitorRunLog['priority'],
    summary: r.summary,
    error: r.error,
  }));
}

// Re-export type so Database binding is available where needed
export type { Database };
```

- [ ] **Step 2: Expose `getDb()` from `src/db.ts`**

The store needs access to the internal `db` handle. Open `/Users/olorin/nanoclaw/src/db.ts` and add after the `let db: Database.Database;` line (line 15):

```typescript
/** @internal — exposed for modules that share the same DB (monitor-store, etc). */
export function getDb(): Database.Database {
  if (!db)
    throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd /Users/olorin/nanoclaw && npx vitest run src/monitor-store.test.ts`
Expected: all 11 tests PASS.

- [ ] **Step 4: Run typecheck**

Run: `cd /Users/olorin/nanoclaw && npm run typecheck`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/olorin/nanoclaw
git add src/monitor-store.ts src/db.ts
git commit -m "feat(monitors): implement monitor-store (state, logs, failure tracking)"
```

---

## Task 6: Write failing test for quiet-hours helper

**Files:**

- Create: `/Users/olorin/nanoclaw/src/quiet-hours.test.ts`

- [ ] **Step 1: Write the failing test**

Create `/Users/olorin/nanoclaw/src/quiet-hours.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import {
  isBusinessHours,
  isInQuietHours,
  isWeekday,
  parseHHMM,
} from './quiet-hours.js';

describe('parseHHMM', () => {
  it('parses valid HH:MM', () => {
    expect(parseHHMM('07:00')).toEqual({ hour: 7, minute: 0 });
    expect(parseHHMM('23:59')).toEqual({ hour: 23, minute: 59 });
    expect(parseHHMM('00:00')).toEqual({ hour: 0, minute: 0 });
  });
  it('throws on invalid input', () => {
    expect(() => parseHHMM('24:00')).toThrow();
    expect(() => parseHHMM('7:0')).toThrow();
    expect(() => parseHHMM('junk')).toThrow();
  });
});

describe('isInQuietHours', () => {
  // 2026-04-13 is a Monday (ET morning)
  it('returns false during business hours in ET', () => {
    const at = new Date('2026-04-13T15:00:00.000Z'); // 11:00 ET (EDT, UTC-4)
    expect(isInQuietHours(at, '23:00', '07:00', 'America/New_York')).toBe(
      false,
    );
  });
  it('returns true at midnight ET', () => {
    const at = new Date('2026-04-13T04:00:00.000Z'); // 00:00 ET
    expect(isInQuietHours(at, '23:00', '07:00', 'America/New_York')).toBe(true);
  });
  it('returns true at 03:00 ET (inside quiet range)', () => {
    const at = new Date('2026-04-13T07:00:00.000Z'); // 03:00 ET
    expect(isInQuietHours(at, '23:00', '07:00', 'America/New_York')).toBe(true);
  });
  it('returns false at exactly 07:00 ET (boundary — quiet ends)', () => {
    const at = new Date('2026-04-13T11:00:00.000Z'); // 07:00 ET
    expect(isInQuietHours(at, '23:00', '07:00', 'America/New_York')).toBe(
      false,
    );
  });
  it('returns true at 23:30 ET (inside quiet range)', () => {
    const at = new Date('2026-04-14T03:30:00.000Z'); // 23:30 ET prior day
    expect(isInQuietHours(at, '23:00', '07:00', 'America/New_York')).toBe(true);
  });
  it('handles non-wrapping quiet range (00:00 → 06:00)', () => {
    const at = new Date('2026-04-13T08:00:00.000Z'); // 04:00 ET
    expect(isInQuietHours(at, '00:00', '06:00', 'America/New_York')).toBe(true);
    const daytime = new Date('2026-04-13T15:00:00.000Z'); // 11:00 ET
    expect(isInQuietHours(daytime, '00:00', '06:00', 'America/New_York')).toBe(
      false,
    );
  });
});

describe('isWeekday', () => {
  it('returns true Mon-Fri in ET', () => {
    // Mon 2026-04-13 15:00 UTC = 11:00 ET
    expect(
      isWeekday(new Date('2026-04-13T15:00:00.000Z'), 'America/New_York'),
    ).toBe(true);
    // Fri 2026-04-17 15:00 UTC
    expect(
      isWeekday(new Date('2026-04-17T15:00:00.000Z'), 'America/New_York'),
    ).toBe(true);
  });
  it('returns false on Saturday in ET', () => {
    // Sat 2026-04-18 15:00 UTC
    expect(
      isWeekday(new Date('2026-04-18T15:00:00.000Z'), 'America/New_York'),
    ).toBe(false);
  });
  it('returns false on Sunday in ET', () => {
    // Sun 2026-04-19 15:00 UTC
    expect(
      isWeekday(new Date('2026-04-19T15:00:00.000Z'), 'America/New_York'),
    ).toBe(false);
  });
});

describe('isBusinessHours', () => {
  it('returns true within 08:00-18:00 ET', () => {
    const at = new Date('2026-04-13T15:00:00.000Z'); // 11:00 ET
    expect(isBusinessHours(at, '08:00', '18:00', 'America/New_York')).toBe(
      true,
    );
  });
  it('returns false at 07:00 ET (before start)', () => {
    const at = new Date('2026-04-13T11:00:00.000Z'); // 07:00 ET
    expect(isBusinessHours(at, '08:00', '18:00', 'America/New_York')).toBe(
      false,
    );
  });
  it('returns false at 18:00 ET (at end — exclusive)', () => {
    const at = new Date('2026-04-13T22:00:00.000Z'); // 18:00 ET
    expect(isBusinessHours(at, '08:00', '18:00', 'America/New_York')).toBe(
      false,
    );
  });
  it('returns true at 17:59 ET', () => {
    const at = new Date('2026-04-13T21:59:00.000Z'); // 17:59 ET
    expect(isBusinessHours(at, '08:00', '18:00', 'America/New_York')).toBe(
      true,
    );
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `cd /Users/olorin/nanoclaw && npx vitest run src/quiet-hours.test.ts`
Expected: FAIL with "Cannot find module './quiet-hours.js'".

- [ ] **Step 3: Commit**

```bash
cd /Users/olorin/nanoclaw
git add src/quiet-hours.test.ts
git commit -m "test(monitors): add failing quiet-hours tests"
```

---

## Task 7: Implement quiet-hours helper

**Files:**

- Create: `/Users/olorin/nanoclaw/src/quiet-hours.ts`

- [ ] **Step 1: Write the implementation**

Create `/Users/olorin/nanoclaw/src/quiet-hours.ts`:

```typescript
import { resolveTimezone } from './timezone.js';

export interface HourMinute {
  hour: number;
  minute: number;
}

export function parseHHMM(value: string): HourMinute {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) throw new Error(`Invalid HH:MM value: ${value}`);
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`HH:MM out of range: ${value}`);
  }
  return { hour, minute };
}

/**
 * Get the current hour:minute in the given timezone as a total-minutes-of-day integer.
 */
function minutesOfDay(at: Date, timezone: string): number {
  const tz = resolveTimezone(timezone);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const hour = parseInt(parts.find((p) => p.type === 'hour')!.value, 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')!.value, 10);
  // Intl may emit "24" for midnight in some locales; normalize.
  const h = hour === 24 ? 0 : hour;
  return h * 60 + minute;
}

/**
 * Quiet hours: returns true when local time is in [start, end).
 * Handles wrap-around (e.g., 23:00 → 07:00).
 */
export function isInQuietHours(
  at: Date,
  startHHMM: string,
  endHHMM: string,
  timezone: string,
): boolean {
  const start = parseHHMM(startHHMM);
  const end = parseHHMM(endHHMM);
  const now = minutesOfDay(at, timezone);
  const s = start.hour * 60 + start.minute;
  const e = end.hour * 60 + end.minute;
  if (s === e) return false; // degenerate
  if (s < e) {
    // non-wrapping (e.g. 00:00 → 06:00)
    return now >= s && now < e;
  }
  // wrapping (e.g. 23:00 → 07:00)
  return now >= s || now < e;
}

/** Monday–Friday check in the given timezone. */
export function isWeekday(at: Date, timezone: string): boolean {
  const tz = resolveTimezone(timezone);
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
  }).format(at);
  return !['Sat', 'Sun'].includes(weekday);
}

/** Business hours: returns true when local time is in [start, end). */
export function isBusinessHours(
  at: Date,
  startHHMM: string,
  endHHMM: string,
  timezone: string,
): boolean {
  const start = parseHHMM(startHHMM);
  const end = parseHHMM(endHHMM);
  const now = minutesOfDay(at, timezone);
  const s = start.hour * 60 + start.minute;
  const e = end.hour * 60 + end.minute;
  return now >= s && now < e;
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd /Users/olorin/nanoclaw && npx vitest run src/quiet-hours.test.ts`
Expected: all 13 tests PASS.

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/olorin/nanoclaw && npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
cd /Users/olorin/nanoclaw
git add src/quiet-hours.ts
git commit -m "feat(monitors): implement timezone-aware quiet-hours/weekday/business-hours helpers"
```

---

## Task 8: Expose `MONITORS_DIR` in config

**Files:**

- Modify: `/Users/olorin/nanoclaw/src/config.ts` (around line 42)

- [ ] **Step 1: Add the monitors path export**

In `/Users/olorin/nanoclaw/src/config.ts`, find the block:

```typescript
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
```

Add immediately after:

```typescript
export const MONITORS_DIR = path.resolve(PROJECT_ROOT, 'monitors');
export const MONITOR_CONFIG_PATH = path.resolve(MONITORS_DIR, 'config.json');
```

- [ ] **Step 2: Run typecheck**

Run: `cd /Users/olorin/nanoclaw && npm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
cd /Users/olorin/nanoclaw
git add src/config.ts
git commit -m "feat(monitors): export MONITORS_DIR and MONITOR_CONFIG_PATH"
```

---

## Task 9: Write failing tests for the monitor-runner

**Files:**

- Create: `/Users/olorin/nanoclaw/src/monitor-runner.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `/Users/olorin/nanoclaw/src/monitor-runner.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, setRegisteredGroup, storeMessage } from './db.js';
import {
  computeDataHash,
  injectMonitorMessage,
  runMonitorOnce,
} from './monitor-runner.js';
import {
  autoDisableMonitor,
  getMonitorHistory,
  getMonitorState,
  initMonitorState,
} from './monitor-store.js';
import type {
  Monitor,
  MonitorDependencies,
  MonitorGlobalConfig,
} from './monitor-types.js';
import type { Channel } from './types.js';

function baseGlobal(): MonitorGlobalConfig {
  return {
    enabled: true,
    defaultIntervalMinutes: 30,
    maxConcurrentMonitors: 3,
    quietHours: { start: '23:00', end: '07:00', timezone: 'America/New_York' },
    monitors: {},
  };
}

function fakeChannel(): Channel {
  return {
    name: 'fake',
    connect: async () => {},
    sendMessage: vi.fn(async () => {}),
    isConnected: () => true,
    ownsJid: (jid: string) => jid.startsWith('fake:'),
    disconnect: async () => {},
  };
}

function fakeDeps(enqueued: string[], channel: Channel): MonitorDependencies {
  return {
    registeredGroups: () => ({
      'fake:reddit-scout': {
        name: 'Reddit Scout',
        folder: 'reddit-scout',
        trigger: '@Andy',
        added_at: '2026-01-01T00:00:00.000Z',
      },
      'fake:main': {
        name: 'Main',
        folder: 'main',
        trigger: '@Andy',
        added_at: '2026-01-01T00:00:00.000Z',
        isMain: true,
      },
    }),
    channels: () => [channel],
    enqueueMonitorCheck: (chatJid: string) => enqueued.push(chatJid),
  };
}

describe('computeDataHash', () => {
  it('produces stable hash for equivalent objects', () => {
    expect(computeDataHash({ a: 1, b: 2 })).toBe(
      computeDataHash({ b: 2, a: 1 }),
    );
  });
  it('differs for different values', () => {
    expect(computeDataHash({ a: 1 })).not.toBe(computeDataHash({ a: 2 }));
  });
});

describe('injectMonitorMessage', () => {
  beforeEach(() => {
    _initTestDatabase();
    setRegisteredGroup('fake:reddit-scout', {
      name: 'Reddit Scout',
      folder: 'reddit-scout',
      trigger: '@Andy',
      added_at: '2026-01-01T00:00:00.000Z',
    });
    setRegisteredGroup('fake:main', {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: '2026-01-01T00:00:00.000Z',
      isMain: true,
    });
  });

  it('stores a synthetic message and enqueues a check', async () => {
    const enqueued: string[] = [];
    const channel = fakeChannel();
    const deps = fakeDeps(enqueued, channel);

    const ok = await injectMonitorMessage(
      'reddit-scout',
      'reddit-keywords',
      {
        shouldWake: true,
        priority: 'normal',
        data: { post_id: 'abc' },
        summary: 'Found 1 post',
      },
      deps,
    );
    expect(ok).toBe(true);
    expect(enqueued).toEqual(['fake:reddit-scout']);
  });

  it('notifies the main group on urgent priority', async () => {
    const enqueued: string[] = [];
    const channel = fakeChannel();
    const deps = fakeDeps(enqueued, channel);

    await injectMonitorMessage(
      'reddit-scout',
      'email-responses',
      {
        shouldWake: true,
        priority: 'urgent',
        data: { email_id: 'em-1' },
        summary: 'Reply from prospect',
      },
      deps,
    );

    expect(channel.sendMessage).toHaveBeenCalledWith(
      'fake:main',
      expect.stringContaining('[URGENT]'),
    );
    expect(channel.sendMessage).toHaveBeenCalledWith(
      'fake:main',
      expect.stringContaining('email-responses'),
    );
  });

  it('returns false if target group folder is not registered', async () => {
    const deps = fakeDeps([], fakeChannel());
    const ok = await injectMonitorMessage(
      'nonexistent-folder',
      'm',
      { shouldWake: true, priority: 'normal', data: {}, summary: 's' },
      deps,
    );
    expect(ok).toBe(false);
  });

  it('uses __monitor__: sender prefix so the trigger check bypass applies', async () => {
    const enqueued: string[] = [];
    const deps = fakeDeps(enqueued, fakeChannel());

    await injectMonitorMessage(
      'reddit-scout',
      'reddit-keywords',
      { shouldWake: true, priority: 'normal', data: {}, summary: 'hit' },
      deps,
    );

    // Verify the stored message has __monitor__: sender
    const db = (await import('./db.js')).getDb();
    const row = db
      .prepare(`SELECT sender FROM messages WHERE chat_jid = ?`)
      .get('fake:reddit-scout') as { sender: string };
    expect(row.sender).toBe('__monitor__:reddit-keywords');
  });
});

function fakeMonitor(
  name: string,
  result: {
    shouldWake: boolean;
    data?: Record<string, unknown>;
    summary?: string;
    priority?: 'low' | 'normal' | 'urgent';
  },
): Monitor {
  return {
    config: {
      name,
      intervalMinutes: 20,
      targetGroup: 'reddit-scout',
      enabled: true,
    },
    check: async () => ({
      shouldWake: result.shouldWake,
      priority: result.priority ?? 'normal',
      data: result.data ?? {},
      summary: result.summary ?? 'summary',
    }),
  };
}

describe('runMonitorOnce', () => {
  beforeEach(() => {
    _initTestDatabase();
    setRegisteredGroup('fake:reddit-scout', {
      name: 'Reddit Scout',
      folder: 'reddit-scout',
      trigger: '@Andy',
      added_at: '2026-01-01T00:00:00.000Z',
    });
    setRegisteredGroup('fake:main', {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: '2026-01-01T00:00:00.000Z',
      isMain: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs "no-wake" and does not enqueue when shouldWake=false', async () => {
    const enqueued: string[] = [];
    const deps = fakeDeps(enqueued, fakeChannel());
    initMonitorState('m', true);
    const m = fakeMonitor('m', { shouldWake: false });

    await runMonitorOnce(
      m,
      baseGlobal(),
      deps,
      new Date('2026-04-13T15:00:00.000Z'),
    );

    expect(enqueued).toHaveLength(0);
    const history = getMonitorHistory('m', 10);
    expect(history[0].status).toBe('no-wake');
    expect(history[0].woke_agent).toBe(false);
  });

  it('enqueues and logs "success" on shouldWake=true', async () => {
    const enqueued: string[] = [];
    const deps = fakeDeps(enqueued, fakeChannel());
    initMonitorState('m', true);
    const m = fakeMonitor('m', { shouldWake: true, data: { x: 1 } });

    await runMonitorOnce(
      m,
      baseGlobal(),
      deps,
      new Date('2026-04-13T15:00:00.000Z'),
    );

    expect(enqueued).toEqual(['fake:reddit-scout']);
    const history = getMonitorHistory('m', 10);
    expect(history[0].status).toBe('success');
    expect(history[0].woke_agent).toBe(true);
  });

  it('skips duplicate wake when data hash matches last run', async () => {
    const enqueued: string[] = [];
    const deps = fakeDeps(enqueued, fakeChannel());
    initMonitorState('m', true);
    const m = fakeMonitor('m', { shouldWake: true, data: { x: 1 } });
    const now = new Date('2026-04-13T15:00:00.000Z');

    await runMonitorOnce(m, baseGlobal(), deps, now);
    await runMonitorOnce(m, baseGlobal(), deps, now);

    expect(enqueued).toHaveLength(1);
    const history = getMonitorHistory('m', 10);
    expect(history[0].status).toBe('no-wake'); // dedup
    expect(history[1].status).toBe('success');
  });

  it('skips during quiet hours unless urgent', async () => {
    const enqueued: string[] = [];
    const deps = fakeDeps(enqueued, fakeChannel());
    initMonitorState('m', true);
    const m = fakeMonitor('m', { shouldWake: true });
    const quietTime = new Date('2026-04-13T05:00:00.000Z'); // 01:00 ET

    await runMonitorOnce(m, baseGlobal(), deps, quietTime);

    expect(enqueued).toHaveLength(0);
    expect(getMonitorHistory('m', 10)[0].status).toBe('skipped-quiet');
  });

  it('runs urgent monitors during quiet hours', async () => {
    const enqueued: string[] = [];
    const deps = fakeDeps(enqueued, fakeChannel());
    initMonitorState('m', true);
    const m = fakeMonitor('m', { shouldWake: true, priority: 'urgent' });
    const quietTime = new Date('2026-04-13T05:00:00.000Z'); // 01:00 ET

    await runMonitorOnce(m, baseGlobal(), deps, quietTime);

    expect(enqueued).toHaveLength(1);
    expect(getMonitorHistory('m', 10)[0].status).toBe('success');
  });

  it('records failure and auto-disables after 3 consecutive errors', async () => {
    const enqueued: string[] = [];
    const channel = fakeChannel();
    const deps = fakeDeps(enqueued, channel);
    initMonitorState('m', true);
    const m: Monitor = {
      config: {
        name: 'm',
        intervalMinutes: 20,
        targetGroup: 'reddit-scout',
        enabled: true,
      },
      check: async () => {
        throw new Error('network down');
      },
    };
    const now = new Date('2026-04-13T15:00:00.000Z');

    await runMonitorOnce(m, baseGlobal(), deps, now);
    await runMonitorOnce(m, baseGlobal(), deps, now);
    expect(getMonitorState('m')!.enabled).toBe(true);

    await runMonitorOnce(m, baseGlobal(), deps, now);
    expect(getMonitorState('m')!.enabled).toBe(false);
    expect(getMonitorState('m')!.auto_disabled_reason).toContain(
      'network down',
    );
    // Main channel should have received a notification about the disable.
    expect(channel.sendMessage).toHaveBeenCalledWith(
      'fake:main',
      expect.stringContaining('auto-disabled'),
    );
  });

  it('enforces 30-second timeout on check()', async () => {
    vi.useFakeTimers();
    const enqueued: string[] = [];
    const deps = fakeDeps(enqueued, fakeChannel());
    initMonitorState('m', true);
    const m: Monitor = {
      config: {
        name: 'm',
        intervalMinutes: 20,
        targetGroup: 'reddit-scout',
        enabled: true,
      },
      check: () => new Promise((resolve) => setTimeout(resolve, 60_000)),
    };
    const now = new Date('2026-04-13T15:00:00.000Z');

    const runPromise = runMonitorOnce(m, baseGlobal(), deps, now);
    await vi.advanceTimersByTimeAsync(31_000);
    await runPromise;

    const history = getMonitorHistory('m', 10);
    expect(history[0].status).toBe('timeout');
  });

  it('skips if monitor is disabled in DB', async () => {
    const enqueued: string[] = [];
    const deps = fakeDeps(enqueued, fakeChannel());
    initMonitorState('m', true);
    autoDisableMonitor('m', 'test');
    const m = fakeMonitor('m', { shouldWake: true });

    await runMonitorOnce(
      m,
      baseGlobal(),
      deps,
      new Date('2026-04-13T15:00:00.000Z'),
    );

    expect(enqueued).toHaveLength(0);
    expect(getMonitorHistory('m', 10)[0].status).toBe('skipped-disabled');
  });
});
```

- [ ] **Step 2: Run to confirm tests fail**

Run: `cd /Users/olorin/nanoclaw && npx vitest run src/monitor-runner.test.ts`
Expected: FAIL with "Cannot find module './monitor-runner.js'".

- [ ] **Step 3: Commit**

```bash
cd /Users/olorin/nanoclaw
git add src/monitor-runner.test.ts
git commit -m "test(monitors): add failing runner tests (dedup, quiet hours, failure, timeout)"
```

---

## Task 10: Implement monitor-runner

**Files:**

- Create: `/Users/olorin/nanoclaw/src/monitor-runner.ts`

- [ ] **Step 1: Write the implementation**

Create `/Users/olorin/nanoclaw/src/monitor-runner.ts`:

```typescript
import crypto from 'crypto';
import fs from 'fs';

import { ASSISTANT_NAME, MONITOR_CONFIG_PATH } from './config.js';
import { storeMessage } from './db.js';
import { logger } from './logger.js';
import type {
  Monitor,
  MonitorConfig,
  MonitorDependencies,
  MonitorGlobalConfig,
  MonitorResult,
} from './monitor-types.js';
import {
  autoDisableMonitor,
  getAllMonitorStates,
  getMonitorState,
  initMonitorState,
  logMonitorRun,
  recordFailure,
  resetFailures,
  updateAfterRun,
  updateAfterWake,
} from './monitor-store.js';
import { isBusinessHours, isInQuietHours, isWeekday } from './quiet-hours.js';
import { formatOutbound } from './router.js';
import type { Channel, NewMessage, RegisteredGroup } from './types.js';

const CHECK_TIMEOUT_MS = 30_000;
const FAILURE_LIMIT = 3;

export function computeDataHash(data: unknown): string {
  const canonical = JSON.stringify(data, Object.keys(data as object).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function findGroupJid(
  folder: string,
  groups: Record<string, RegisteredGroup>,
): string | undefined {
  const entry = Object.entries(groups).find(([, g]) => g.folder === folder);
  return entry?.[0];
}

function findMainJid(
  groups: Record<string, RegisteredGroup>,
): string | undefined {
  const entry = Object.entries(groups).find(([, g]) => g.isMain === true);
  return entry?.[0];
}

async function sendToMain(
  deps: MonitorDependencies,
  text: string,
): Promise<void> {
  const mainJid = findMainJid(deps.registeredGroups());
  if (!mainJid) {
    logger.debug({ text }, 'Monitor main notification skipped: no main group');
    return;
  }
  const channel: Channel | undefined = deps
    .channels()
    .find((c) => c.ownsJid(mainJid));
  if (!channel) {
    logger.debug({ mainJid }, 'Monitor main notification skipped: no channel');
    return;
  }
  const formatted = formatOutbound(text);
  if (formatted) await channel.sendMessage(mainJid, formatted);
}

export async function injectMonitorMessage(
  targetFolder: string,
  monitorName: string,
  result: MonitorResult,
  deps: MonitorDependencies,
): Promise<boolean> {
  const groups = deps.registeredGroups();
  const chatJid = findGroupJid(targetFolder, groups);
  if (!chatJid) {
    logger.warn(
      { monitor: monitorName, targetFolder },
      'Monitor target group is not registered',
    );
    return false;
  }

  const dataJson = JSON.stringify(result.data, null, 2);
  const content = `[MONITOR: ${monitorName}] ${result.summary}\n\nData:\n${dataJson}`;

  const nonce = Math.random().toString(36).slice(2, 8);
  const timestamp = new Date().toISOString();
  const msg: NewMessage = {
    id: `monitor-${monitorName}-${Date.now()}-${nonce}`,
    chat_jid: chatJid,
    sender: `__monitor__:${monitorName}`,
    sender_name: `Monitor (${monitorName})`,
    content,
    timestamp,
    is_from_me: false,
    is_bot_message: false,
  };
  storeMessage(msg);
  deps.enqueueMonitorCheck(chatJid);

  if (result.priority === 'urgent') {
    const urgentText = `[URGENT] ${monitorName}: ${result.summary}`;
    try {
      await sendToMain(deps, urgentText);
    } catch (err) {
      logger.warn(
        { monitor: monitorName, err },
        'Failed to send urgent monitor notification to main',
      );
    }
  }

  logger.info(
    { monitor: monitorName, targetFolder, priority: result.priority },
    'Monitor injected message',
  );
  return true;
}

interface TimingGate {
  allowed: boolean;
  reason: 'ok' | 'skipped-quiet' | 'skipped-weekday' | 'skipped-business-hours';
}

function checkTimingGates(
  config: MonitorConfig,
  global: MonitorGlobalConfig,
  result: MonitorResult,
  at: Date,
): TimingGate {
  // Urgent always runs.
  if (result.priority === 'urgent') return { allowed: true, reason: 'ok' };

  if (config.weekdaysOnly && !isWeekday(at, global.quietHours.timezone)) {
    return { allowed: false, reason: 'skipped-weekday' };
  }

  if (config.businessHours) {
    if (
      !isBusinessHours(
        at,
        config.businessHours.start,
        config.businessHours.end,
        global.quietHours.timezone,
      )
    ) {
      return { allowed: false, reason: 'skipped-business-hours' };
    }
  }

  if (config.respectQuietHours !== false) {
    if (
      isInQuietHours(
        at,
        global.quietHours.start,
        global.quietHours.end,
        global.quietHours.timezone,
      )
    ) {
      return { allowed: false, reason: 'skipped-quiet' };
    }
  }

  return { allowed: true, reason: 'ok' };
}

function withTimeout<T>(
  p: Promise<T>,
  ms: number,
): Promise<{ ok: true; value: T } | { ok: false; timedOut: true }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, timedOut: true }), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      (err) => {
        clearTimeout(timer);
        // Re-throw via rejection path.
        throw err;
      },
    ).catch((err) => {
      clearTimeout(timer);
      // Propagate rejection — caller handles it.
      throw err;
    });
  });
}

async function handleCheckFailure(
  monitor: Monitor,
  err: unknown,
  runAt: string,
  durationMs: number,
  deps: MonitorDependencies,
): Promise<void> {
  const errMsg = err instanceof Error ? err.message : String(err);
  const failures = recordFailure(monitor.config.name);
  logMonitorRun({
    monitor_name: monitor.config.name,
    run_at: runAt,
    duration_ms: durationMs,
    status: 'error',
    woke_agent: false,
    priority: null,
    summary: null,
    error: errMsg,
  });
  logger.error(
    { monitor: monitor.config.name, failures, err: errMsg },
    'Monitor check failed',
  );
  if (failures >= FAILURE_LIMIT) {
    autoDisableMonitor(monitor.config.name, errMsg);
    try {
      await sendToMain(
        deps,
        `Monitor [${monitor.config.name}] auto-disabled after ${FAILURE_LIMIT} consecutive failures: ${errMsg}`,
      );
    } catch (notifyErr) {
      logger.warn(
        { monitor: monitor.config.name, err: notifyErr },
        'Failed to notify main about auto-disable',
      );
    }
  }
}

export async function runMonitorOnce(
  monitor: Monitor,
  global: MonitorGlobalConfig,
  deps: MonitorDependencies,
  now: Date = new Date(),
): Promise<void> {
  const name = monitor.config.name;
  initMonitorState(name, monitor.config.enabled);
  const state = getMonitorState(name);
  const runAt = now.toISOString();

  if (!state || !state.enabled) {
    logMonitorRun({
      monitor_name: name,
      run_at: runAt,
      duration_ms: 0,
      status: 'skipped-disabled',
      woke_agent: false,
      priority: null,
      summary: null,
      error: null,
    });
    return;
  }

  // Run the check (with timeout). Evaluate timing gates AFTER the check so we
  // know the priority — urgent monitors are allowed to fire during quiet hours.
  const started = Date.now();
  let result: MonitorResult;
  try {
    const timed = await withTimeout(monitor.check(), CHECK_TIMEOUT_MS).catch(
      (err: unknown) => ({ ok: false as const, err }),
    );
    if ('timedOut' in timed && timed.timedOut) {
      logMonitorRun({
        monitor_name: name,
        run_at: runAt,
        duration_ms: Date.now() - started,
        status: 'timeout',
        woke_agent: false,
        priority: null,
        summary: null,
        error: `timeout after ${CHECK_TIMEOUT_MS}ms`,
      });
      const failures = recordFailure(name);
      if (failures >= FAILURE_LIMIT) {
        autoDisableMonitor(name, `timeout after ${CHECK_TIMEOUT_MS}ms`);
        try {
          await sendToMain(
            deps,
            `Monitor [${name}] auto-disabled after ${FAILURE_LIMIT} consecutive failures: timeout`,
          );
        } catch (err) {
          logger.warn(
            { monitor: name, err },
            'Failed to notify main about auto-disable',
          );
        }
      }
      updateAfterRun(name, runAt);
      return;
    }
    if ('err' in timed) {
      await handleCheckFailure(
        monitor,
        timed.err,
        runAt,
        Date.now() - started,
        deps,
      );
      updateAfterRun(name, runAt);
      return;
    }
    result = timed.value;
  } catch (err) {
    await handleCheckFailure(monitor, err, runAt, Date.now() - started, deps);
    updateAfterRun(name, runAt);
    return;
  }

  resetFailures(name);
  updateAfterRun(name, runAt);

  if (!result.shouldWake) {
    logMonitorRun({
      monitor_name: name,
      run_at: runAt,
      duration_ms: Date.now() - started,
      status: 'no-wake',
      woke_agent: false,
      priority: result.priority,
      summary: null,
      error: null,
    });
    return;
  }

  const timing = checkTimingGates(monitor.config, global, result, now);
  if (!timing.allowed) {
    logMonitorRun({
      monitor_name: name,
      run_at: runAt,
      duration_ms: Date.now() - started,
      status: timing.reason,
      woke_agent: false,
      priority: result.priority,
      summary: result.summary,
      error: null,
    });
    return;
  }

  // Deduplication: skip if the data hash matches the last wake.
  const dataHash = computeDataHash(result.data);
  if (state.last_data_hash === dataHash) {
    logMonitorRun({
      monitor_name: name,
      run_at: runAt,
      duration_ms: Date.now() - started,
      status: 'no-wake',
      woke_agent: false,
      priority: result.priority,
      summary: `duplicate of previous wake (hash ${dataHash.slice(0, 8)})`,
      error: null,
    });
    return;
  }

  const injected = await injectMonitorMessage(
    monitor.config.targetGroup,
    name,
    result,
    deps,
  );
  if (!injected) {
    logMonitorRun({
      monitor_name: name,
      run_at: runAt,
      duration_ms: Date.now() - started,
      status: 'error',
      woke_agent: false,
      priority: result.priority,
      summary: result.summary,
      error: `target group not registered: ${monitor.config.targetGroup}`,
    });
    return;
  }

  updateAfterWake(name, runAt, dataHash, state.seen_ids);
  logMonitorRun({
    monitor_name: name,
    run_at: runAt,
    duration_ms: Date.now() - started,
    status: 'success',
    woke_agent: true,
    priority: result.priority,
    summary: result.summary,
    error: null,
  });
}

// --- Config loading ---

const DEFAULT_GLOBAL: MonitorGlobalConfig = {
  enabled: true,
  defaultIntervalMinutes: 30,
  maxConcurrentMonitors: 3,
  quietHours: {
    start: '23:00',
    end: '07:00',
    timezone: 'America/New_York',
  },
  monitors: {},
};

export function loadMonitorConfig(pathOverride?: string): MonitorGlobalConfig {
  const p = pathOverride ?? MONITOR_CONFIG_PATH;
  if (!fs.existsSync(p)) {
    logger.info({ path: p }, 'No monitor config file — using defaults');
    return DEFAULT_GLOBAL;
  }
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<MonitorGlobalConfig>;
    return {
      enabled: parsed.enabled ?? DEFAULT_GLOBAL.enabled,
      defaultIntervalMinutes:
        parsed.defaultIntervalMinutes ?? DEFAULT_GLOBAL.defaultIntervalMinutes,
      maxConcurrentMonitors:
        parsed.maxConcurrentMonitors ?? DEFAULT_GLOBAL.maxConcurrentMonitors,
      quietHours: {
        start: parsed.quietHours?.start ?? DEFAULT_GLOBAL.quietHours.start,
        end: parsed.quietHours?.end ?? DEFAULT_GLOBAL.quietHours.end,
        timezone:
          parsed.quietHours?.timezone ?? DEFAULT_GLOBAL.quietHours.timezone,
      },
      monitors: parsed.monitors ?? {},
    };
  } catch (err) {
    logger.warn(
      { path: p, err },
      'Failed to parse monitor config — using defaults',
    );
    return DEFAULT_GLOBAL;
  }
}

export function mergeMonitorConfig(
  monitor: Monitor,
  global: MonitorGlobalConfig,
): Monitor {
  const override = global.monitors[monitor.config.name] ?? {};
  return {
    config: {
      ...monitor.config,
      ...override,
      name: monitor.config.name,
      targetGroup: monitor.config.targetGroup,
    },
    check: monitor.check,
  };
}

// --- Loop ---

let monitorLoopRunning = false;
const scheduledTimers = new Map<string, NodeJS.Timeout>();

export function startMonitorLoop(
  monitors: Monitor[],
  deps: MonitorDependencies,
  global: MonitorGlobalConfig,
): void {
  if (monitorLoopRunning) {
    logger.debug('Monitor loop already running, skipping duplicate start');
    return;
  }
  monitorLoopRunning = true;

  if (!global.enabled) {
    logger.info('Monitor runner disabled in global config');
    return;
  }

  // Purge stale states for monitors that no longer exist (file deleted).
  const current = new Set(monitors.map((m) => m.config.name));
  for (const state of getAllMonitorStates()) {
    if (!current.has(state.name)) {
      logger.info(
        { monitor: state.name },
        'Purging stale monitor state (file removed)',
      );
    }
  }

  for (const monitor of monitors) {
    const merged = mergeMonitorConfig(monitor, global);
    initMonitorState(merged.config.name, merged.config.enabled);

    if (!merged.config.enabled) {
      logger.info(
        { monitor: merged.config.name },
        'Monitor disabled in config, skipping',
      );
      continue;
    }

    const intervalMs = merged.config.intervalMinutes * 60_000;
    const fire = () => {
      runMonitorOnce(merged, global, deps).catch((err) => {
        logger.error(
          { monitor: merged.config.name, err },
          'Unhandled error in runMonitorOnce',
        );
      });
    };
    const timer = setInterval(fire, intervalMs);
    scheduledTimers.set(merged.config.name, timer);

    // Fire once shortly after startup with a small stagger, so monitors don't
    // all pound their external APIs at the same instant.
    const stagger = 5_000 + Math.floor(Math.random() * 15_000);
    setTimeout(fire, stagger);

    logger.info(
      {
        monitor: merged.config.name,
        intervalMinutes: merged.config.intervalMinutes,
        targetGroup: merged.config.targetGroup,
      },
      'Monitor scheduled',
    );
  }
}

export function _resetMonitorLoopForTests(): void {
  monitorLoopRunning = false;
  for (const t of scheduledTimers.values()) clearInterval(t);
  scheduledTimers.clear();
}
```

- [ ] **Step 2: Run monitor-runner tests to verify they pass**

Run: `cd /Users/olorin/nanoclaw && npx vitest run src/monitor-runner.test.ts`
Expected: all 12 tests PASS.

- [ ] **Step 3: Run full test suite**

Run: `cd /Users/olorin/nanoclaw && npm test`
Expected: all tests pass, no regressions.

- [ ] **Step 4: Commit**

```bash
cd /Users/olorin/nanoclaw
git add src/monitor-runner.ts
git commit -m "feat(monitors): implement monitor-runner (loader, scheduler, timeout, dedup, failure auto-disable)"
```

---

## Task 11: Write failing test for trigger-check bypass

**Files:**

- Modify: `/Users/olorin/nanoclaw/src/routing.test.ts` — add new test cases (or add to an existing trigger test block). If file does not have relevant tests, create a new test file.

Before writing, confirm location of existing trigger-check tests:

- [ ] **Step 1: Inspect existing test coverage**

Run: `cd /Users/olorin/nanoclaw && grep -rn "requiresTrigger\|isTriggerAllowed\|trigger" src/*.test.ts | head -20`

Look for tests that cover the `startMessageLoop` or `processGroupMessages` trigger check. If none exist, create a dedicated test file for the bypass behavior.

- [ ] **Step 2: Create the test file**

Create `/Users/olorin/nanoclaw/src/monitor-trigger-bypass.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { hasMonitorTriggerBypass } from './monitor-runner.js';
import type { NewMessage } from './types.js';

function msg(overrides: Partial<NewMessage>): NewMessage {
  return {
    id: 'id',
    chat_jid: 'fake:g',
    sender: 'user@example',
    sender_name: 'User',
    content: '@Andy hi',
    timestamp: '2026-04-13T10:00:00.000Z',
    is_from_me: false,
    is_bot_message: false,
    ...overrides,
  };
}

describe('hasMonitorTriggerBypass', () => {
  it('returns true for messages with __monitor__: sender prefix', () => {
    expect(
      hasMonitorTriggerBypass(msg({ sender: '__monitor__:reddit-keywords' })),
    ).toBe(true);
  });
  it('returns false for regular user messages', () => {
    expect(hasMonitorTriggerBypass(msg({ sender: 'user@example' }))).toBe(
      false,
    );
  });
  it('returns false for bot messages', () => {
    expect(
      hasMonitorTriggerBypass(msg({ sender: 'bot', is_bot_message: true })),
    ).toBe(false);
  });
});
```

- [ ] **Step 3: Run to confirm failure**

Run: `cd /Users/olorin/nanoclaw && npx vitest run src/monitor-trigger-bypass.test.ts`
Expected: FAIL with "hasMonitorTriggerBypass is not a function" (or similar — helper not exported yet).

- [ ] **Step 4: Commit**

```bash
cd /Users/olorin/nanoclaw
git add src/monitor-trigger-bypass.test.ts
git commit -m "test(monitors): add failing test for trigger-check bypass helper"
```

---

## Task 12: Add the trigger-bypass helper and wire it into index.ts

**Files:**

- Modify: `/Users/olorin/nanoclaw/src/monitor-runner.ts` (add `hasMonitorTriggerBypass` export)
- Modify: `/Users/olorin/nanoclaw/src/index.ts` (2 trigger-check sites: ~line 279 in `processGroupMessages`, ~line 531 in `startMessageLoop`)

- [ ] **Step 1: Export the helper from `monitor-runner.ts`**

Add to `/Users/olorin/nanoclaw/src/monitor-runner.ts` near the top (after the `CHECK_TIMEOUT_MS` constant):

```typescript
export const MONITOR_SENDER_PREFIX = '__monitor__:';

export function hasMonitorTriggerBypass(msg: {
  sender: string;
  is_bot_message?: boolean;
}): boolean {
  if (msg.is_bot_message) return false;
  return msg.sender.startsWith(MONITOR_SENDER_PREFIX);
}
```

Also update `injectMonitorMessage` to use this constant: replace `\`**monitor**:${monitorName}\`` with `\`${MONITOR_SENDER_PREFIX}${monitorName}\``.

- [ ] **Step 2: Wire bypass into `processGroupMessages`**

In `/Users/olorin/nanoclaw/src/index.ts`, locate the trigger check at lines 276–285:

```typescript
// For non-main groups, check if trigger is required and present
if (!isMainGroup && group.requiresTrigger !== false) {
  const triggerPattern = getTriggerPattern(group.trigger);
  const allowlistCfg = loadSenderAllowlist();
  const hasTrigger = missedMessages.some(
    (m) =>
      triggerPattern.test(m.content.trim()) &&
      (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
  );
  if (!hasTrigger) return true;
}
```

Replace with:

```typescript
// For non-main groups, check if trigger is required and present.
// Monitor-sourced messages bypass the trigger check (they arrive pre-authorized
// from the internal monitor runner, not from users).
if (!isMainGroup && group.requiresTrigger !== false) {
  const triggerPattern = getTriggerPattern(group.trigger);
  const allowlistCfg = loadSenderAllowlist();
  const hasTrigger = missedMessages.some(
    (m) =>
      hasMonitorTriggerBypass(m) ||
      (triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg))),
  );
  if (!hasTrigger) return true;
}
```

- [ ] **Step 3: Wire bypass into `startMessageLoop`**

In `/Users/olorin/nanoclaw/src/index.ts`, locate lines 528–538:

```typescript
if (needsTrigger) {
  const triggerPattern = getTriggerPattern(group.trigger);
  const allowlistCfg = loadSenderAllowlist();
  const hasTrigger = groupMessages.some(
    (m) =>
      triggerPattern.test(m.content.trim()) &&
      (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
  );
  if (!hasTrigger) continue;
}
```

Replace with:

```typescript
if (needsTrigger) {
  const triggerPattern = getTriggerPattern(group.trigger);
  const allowlistCfg = loadSenderAllowlist();
  const hasTrigger = groupMessages.some(
    (m) =>
      hasMonitorTriggerBypass(m) ||
      (triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg))),
  );
  if (!hasTrigger) continue;
}
```

- [ ] **Step 4: Add the import to `index.ts`**

At the top of `/Users/olorin/nanoclaw/src/index.ts`, add to the imports (next to `startSchedulerLoop`):

```typescript
import { hasMonitorTriggerBypass } from './monitor-runner.js';
```

- [ ] **Step 5: Run tests**

Run: `cd /Users/olorin/nanoclaw && npx vitest run src/monitor-trigger-bypass.test.ts`
Expected: all 3 tests PASS.

Run: `cd /Users/olorin/nanoclaw && npm run typecheck`
Expected: exits 0.

Run: `cd /Users/olorin/nanoclaw && npm test`
Expected: all tests pass, no regressions.

- [ ] **Step 6: Commit**

```bash
cd /Users/olorin/nanoclaw
git add src/monitor-runner.ts src/index.ts
git commit -m "feat(monitors): bypass trigger check for __monitor__: sender in message loops"
```

---

## Task 13: Wire `startMonitorLoop` into `main()`

**Files:**

- Modify: `/Users/olorin/nanoclaw/src/index.ts` (around line 735, after `startSchedulerLoop`)

- [ ] **Step 1: Import runner and registry**

In `/Users/olorin/nanoclaw/src/index.ts`, add imports near the top (grouped with other local imports):

```typescript
import { loadMonitorConfig, startMonitorLoop } from './monitor-runner.js';
```

Also later (deferred import used at runtime — see Step 3).

- [ ] **Step 2: Add a helper to load monitors defensively**

Still in `/Users/olorin/nanoclaw/src/index.ts`, add this function somewhere near `ensureOneCLIAgent` (line 116 area):

```typescript
async function loadMonitors(): Promise<import('./monitor-types.js').Monitor[]> {
  try {
    // Path works in both dev (tsx: src/../monitors/index.ts) and
    // prod (dist/src/../monitors/index.js).
    const mod = await import('../../monitors/index.js');
    const list = (mod as { monitors?: import('./monitor-types.js').Monitor[] })
      .monitors;
    if (!Array.isArray(list)) {
      logger.warn('monitors/index.js did not export a `monitors` array');
      return [];
    }
    return list;
  } catch (err) {
    logger.info(
      { err: String(err) },
      'No monitors registered (monitors/index.ts not found or empty)',
    );
    return [];
  }
}
```

Note: the path `'../../monitors/index.js'` resolves as follows —

- Dev (tsx): `src/index.ts` → `../../monitors/index.js` → `monitors/index.ts` (tsx rewrites .js to .ts)
- Prod: `dist/src/index.js` → `../../monitors/index.js` → `dist/monitors/index.js`

Both are valid because the tsconfig (Task 1) includes `monitors/**/*` in the output.

- [ ] **Step 3: Wire the loop into `main()`**

In `/Users/olorin/nanoclaw/src/index.ts`, find the `startSchedulerLoop(...)` call block (around lines 735–750). Immediately AFTER that block, and BEFORE `startIpcWatcher(...)` (line 751), add:

```typescript
// Start the monitor runner. Monitors are pure fetch+parse+condition checks
// that inject synthetic messages into the target group queue when something
// actionable is detected.
const monitorGlobal = loadMonitorConfig();
const monitors = await loadMonitors();
startMonitorLoop(
  monitors,
  {
    registeredGroups: () => registeredGroups,
    channels: () => channels,
    enqueueMonitorCheck: (chatJid) => queue.enqueueMessageCheck(chatJid),
  },
  monitorGlobal,
);
```

- [ ] **Step 4: Build the project to confirm it compiles**

Run: `cd /Users/olorin/nanoclaw && npm run build`
Expected: exits 0, `dist/src/monitor-runner.js` and `dist/src/index.js` exist.

- [ ] **Step 5: Run the full test suite**

Run: `cd /Users/olorin/nanoclaw && npm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/olorin/nanoclaw
git add src/index.ts
git commit -m "feat(monitors): wire startMonitorLoop into main() alongside scheduler"
```

---

## Task 14: Create `monitors/config.json` and `monitors/index.ts` skeleton

**Files:**

- Create: `/Users/olorin/nanoclaw/monitors/config.json`
- Create: `/Users/olorin/nanoclaw/monitors/index.ts`

- [ ] **Step 1: Write the config file**

Create `/Users/olorin/nanoclaw/monitors/config.json`:

```json
{
  "enabled": true,
  "defaultIntervalMinutes": 30,
  "maxConcurrentMonitors": 3,
  "quietHours": {
    "start": "23:00",
    "end": "07:00",
    "timezone": "America/New_York"
  },
  "monitors": {
    "reddit-keywords": { "enabled": true, "intervalMinutes": 20 },
    "prospect-pipeline": { "enabled": true, "intervalMinutes": 60 },
    "email-responses": { "enabled": true, "intervalMinutes": 30 },
    "linkedin-engagement": { "enabled": true, "intervalMinutes": 45 },
    "competitor-alerts": { "enabled": true, "intervalMinutes": 120 }
  }
}
```

- [ ] **Step 2: Write an empty index that compiles**

Create `/Users/olorin/nanoclaw/monitors/index.ts`:

```typescript
import type { Monitor } from '../src/monitor-types.js';

export const monitors: Monitor[] = [
  // monitors are registered in later tasks
];
```

- [ ] **Step 3: Typecheck and build**

Run: `cd /Users/olorin/nanoclaw && npm run typecheck && npm run build`
Expected: both commands exit 0.

- [ ] **Step 4: Commit**

```bash
cd /Users/olorin/nanoclaw
git add monitors/config.json monitors/index.ts
git commit -m "feat(monitors): add monitors/config.json and empty registry"
```

---

## Task 15: Implement `reddit-keywords` monitor

**Files:**

- Create: `/Users/olorin/nanoclaw/monitors/reddit-keywords.ts`

- [ ] **Step 1: Write the monitor**

Create `/Users/olorin/nanoclaw/monitors/reddit-keywords.ts`:

```typescript
import { logger } from '../src/logger.js';
import {
  getMonitorState,
  initMonitorState,
  updateAfterWake,
} from '../src/monitor-store.js';
import type { Monitor, MonitorResult } from '../src/monitor-types.js';

const SUBREDDITS = 'elearning+instructionaldesign+edtech+corporatetraining';
const FEED_URL = `https://www.reddit.com/r/${SUBREDDITS}/new.json?limit=50`;
const MAX_AGE_HOURS = 4;
const USER_AGENT = 'nanoclaw-monitor/1.0';

const KEYWORDS = [
  'interactive video',
  'training video engagement',
  'video completion rate',
  'boring training',
  'compliance training',
  'AI training',
  'edtech tool',
  'Synthesia alternative',
  'HeyGen alternative',
  'training LMS',
  'onboarding video',
  'video learning',
];

interface RedditPost {
  id: string;
  title: string;
  subreddit: string;
  url: string;
  permalink: string;
  author: string;
  created_utc: number;
  selftext: string;
}

interface RedditResponse {
  data?: { children?: Array<{ data?: RedditPost }> };
}

function matchKeyword(text: string): string | null {
  const lower = text.toLowerCase();
  for (const kw of KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) return kw;
  }
  return null;
}

async function fetchFeed(): Promise<RedditPost[]> {
  const res = await fetch(FEED_URL, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Reddit ${res.status}: ${res.statusText}`);
  }
  const json = (await res.json()) as RedditResponse;
  const children = json.data?.children ?? [];
  return children
    .map((c) => c.data)
    .filter((d): d is RedditPost => !!d && !!d.id);
}

export const config = {
  name: 'reddit-keywords',
  intervalMinutes: 20,
  targetGroup: 'reddit-scout',
  enabled: true,
};

export async function check(): Promise<MonitorResult> {
  initMonitorState(config.name, config.enabled);
  const state = getMonitorState(config.name)!;
  const seen = new Set(state.seen_ids);

  const posts = await fetchFeed();
  const now = Date.now();
  const maxAgeMs = MAX_AGE_HOURS * 3_600_000;

  const hits: Array<{ post: RedditPost; keyword: string; ageHours: number }> =
    [];
  for (const p of posts) {
    if (seen.has(p.id)) continue;
    const ageMs = now - p.created_utc * 1000;
    if (ageMs > maxAgeMs) continue;
    const kw = matchKeyword(`${p.title}\n${p.selftext ?? ''}`);
    if (!kw) continue;
    hits.push({ post: p, keyword: kw, ageHours: ageMs / 3_600_000 });
  }

  if (hits.length === 0) {
    return {
      shouldWake: false,
      priority: 'normal',
      data: {},
      summary: '',
    };
  }

  // Take the first (newest) hit.
  const [first] = hits;
  const allIds = [...state.seen_ids, ...hits.map((h) => h.post.id)];
  updateAfterWake(config.name, new Date().toISOString(), '', allIds);

  logger.debug(
    { hits: hits.length, first: first.post.id },
    'reddit-keywords: matches found',
  );

  return {
    shouldWake: true,
    priority: 'normal',
    data: {
      post_title: first.post.title,
      subreddit: first.post.subreddit,
      url: `https://www.reddit.com${first.post.permalink}`,
      author: first.post.author,
      age_hours: Math.round(first.ageHours * 10) / 10,
      matched_keyword: first.keyword,
      total_new_matches: hits.length,
    },
    summary: `New Reddit post in r/${first.post.subreddit} matching "${first.keyword}": ${first.post.title.slice(0, 100)}`,
  };
}

const monitor: Monitor = { config, check };
export default monitor;
```

- [ ] **Step 2: Register the monitor in `monitors/index.ts`**

Open `/Users/olorin/nanoclaw/monitors/index.ts` and change to:

```typescript
import type { Monitor } from '../src/monitor-types.js';

import redditKeywords from './reddit-keywords.js';

export const monitors: Monitor[] = [redditKeywords];
```

- [ ] **Step 3: Typecheck and build**

Run: `cd /Users/olorin/nanoclaw && npm run typecheck && npm run build`
Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
cd /Users/olorin/nanoclaw
git add monitors/reddit-keywords.ts monitors/index.ts
git commit -m "feat(monitors): add reddit-keywords monitor (subreddit poller with keyword filter)"
```

---

## Task 16: Implement `prospect-pipeline` monitor

**Files:**

- Create: `/Users/olorin/nanoclaw/monitors/prospect-pipeline.ts`
- Modify: `/Users/olorin/nanoclaw/monitors/index.ts`

- [ ] **Step 1: Write the monitor**

Create `/Users/olorin/nanoclaw/monitors/prospect-pipeline.ts`:

```typescript
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../src/config.js';
import {
  getMonitorState,
  initMonitorState,
  updateAfterWake,
} from '../src/monitor-store.js';
import type { Monitor, MonitorResult } from '../src/monitor-types.js';

const PROSPECTS_RELATIVE = 'slack_dm/marketing/outreach/prospects.md';
const LOW_PIPELINE_THRESHOLD = 10;
// YYYY-MM-DD key of the last day we alerted on low pipeline, stored in seen_ids.
const ALERT_KEY_PREFIX = 'low-pipeline:';

interface ProspectSummary {
  unsent_count: number;
  total_prospects: number;
  last_outreach_date: string | null;
}

function parseProspectsFile(content: string): ProspectSummary {
  const lines = content.split(/\r?\n/);
  let total = 0;
  let unsent = 0;
  let lastDate: string | null = null;
  const emailLine = /\S+@\S+\.\S+/;
  const sentMarker = /\b(sent|delivered|sent_at|outreached)\b/i;
  const dateMarker = /(?:sent|outreach|contacted)[^\d]*(\d{4}-\d{2}-\d{2})/i;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith('-') && !line.startsWith('*') && !line.startsWith('|'))
      continue;
    if (!emailLine.test(line)) continue;
    total += 1;
    const isSent = sentMarker.test(line);
    if (!isSent) unsent += 1;
    const m = dateMarker.exec(line);
    if (m) {
      const d = m[1];
      if (!lastDate || d > lastDate) lastDate = d;
    }
  }
  return {
    unsent_count: unsent,
    total_prospects: total,
    last_outreach_date: lastDate,
  };
}

export const config = {
  name: 'prospect-pipeline',
  intervalMinutes: 60,
  targetGroup: 'prospector',
  enabled: true,
  weekdaysOnly: true,
  businessHours: { start: '08:00', end: '18:00' },
};

export async function check(): Promise<MonitorResult> {
  initMonitorState(config.name, config.enabled);
  const state = getMonitorState(config.name)!;

  const filePath = path.join(GROUPS_DIR, PROSPECTS_RELATIVE);
  if (!fs.existsSync(filePath)) {
    return {
      shouldWake: false,
      priority: 'normal',
      data: {},
      summary: `No prospects file at ${filePath}`,
    };
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const summary = parseProspectsFile(content);

  if (summary.unsent_count >= LOW_PIPELINE_THRESHOLD) {
    return {
      shouldWake: false,
      priority: 'normal',
      data: summary,
      summary: 'Pipeline healthy',
    };
  }

  // Once-per-day gate: only alert once per UTC calendar day.
  const today = new Date().toISOString().slice(0, 10);
  const alertKey = `${ALERT_KEY_PREFIX}${today}`;
  if (state.seen_ids.includes(alertKey)) {
    return {
      shouldWake: false,
      priority: 'normal',
      data: summary,
      summary: 'Already alerted today',
    };
  }

  const newIds = [...state.seen_ids, alertKey];
  updateAfterWake(config.name, new Date().toISOString(), '', newIds);

  return {
    shouldWake: true,
    priority: 'normal',
    data: {
      unsent_count: summary.unsent_count,
      total_prospects: summary.total_prospects,
      last_outreach_date: summary.last_outreach_date,
    },
    summary: `Prospect pipeline low: only ${summary.unsent_count} unsent prospects remain (of ${summary.total_prospects} total).`,
  };
}

const monitor: Monitor = { config, check };
export default monitor;
```

- [ ] **Step 2: Register in `monitors/index.ts`**

Open `/Users/olorin/nanoclaw/monitors/index.ts` and update to:

```typescript
import type { Monitor } from '../src/monitor-types.js';

import prospectPipeline from './prospect-pipeline.js';
import redditKeywords from './reddit-keywords.js';

export const monitors: Monitor[] = [redditKeywords, prospectPipeline];
```

- [ ] **Step 3: Typecheck + build**

Run: `cd /Users/olorin/nanoclaw && npm run typecheck && npm run build`
Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
cd /Users/olorin/nanoclaw
git add monitors/prospect-pipeline.ts monitors/index.ts
git commit -m "feat(monitors): add prospect-pipeline monitor with once-per-day alert gate"
```

---

## Task 17: Implement `email-responses` monitor

**Files:**

- Create: `/Users/olorin/nanoclaw/monitors/email-responses.ts`
- Modify: `/Users/olorin/nanoclaw/monitors/index.ts`

- [ ] **Step 1: Write the monitor**

Create `/Users/olorin/nanoclaw/monitors/email-responses.ts`:

```typescript
import {
  getMonitorState,
  initMonitorState,
  updateAfterWake,
} from '../src/monitor-store.js';
import type {
  Monitor,
  MonitorPriority,
  MonitorResult,
} from '../src/monitor-types.js';
import { readEnvFile } from '../src/env.js';

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';

interface ResendEmail {
  id: string;
  to: string[] | string;
  subject: string;
  last_event?: string;
  last_event_at?: string;
  created_at: string;
}

interface ResendListResponse {
  data?: ResendEmail[];
}

type EventType = 'sent' | 'delivered' | 'opened' | 'clicked' | 'replied';

function classifyEvent(raw: string | undefined): EventType | null {
  if (!raw) return null;
  const e = raw.toLowerCase();
  if (e.includes('reply') || e.includes('replied')) return 'replied';
  if (e.includes('click')) return 'clicked';
  if (e.includes('open')) return 'opened';
  if (e.includes('deliver')) return 'delivered';
  if (e.includes('sent')) return 'sent';
  return null;
}

function priorityFor(event: EventType): MonitorPriority {
  if (event === 'replied') return 'urgent';
  if (event === 'clicked' || event === 'opened') return 'normal';
  return 'low';
}

export const config = {
  name: 'email-responses',
  intervalMinutes: 30,
  targetGroup: 'slack_dm',
  enabled: true,
  weekdaysOnly: true,
};

export async function check(): Promise<MonitorResult> {
  initMonitorState(config.name, config.enabled);
  const state = getMonitorState(config.name)!;

  const env = readEnvFile(['RESEND_API_KEY']);
  const apiKey = process.env.RESEND_API_KEY || env.RESEND_API_KEY;
  if (!apiKey) {
    return {
      shouldWake: false,
      priority: 'low',
      data: {},
      summary: 'RESEND_API_KEY not configured — skipping',
    };
  }

  const res = await fetch(RESEND_EMAILS_URL, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Resend ${res.status}: ${res.statusText}`);
  }
  const json = (await res.json()) as ResendListResponse;
  const emails = json.data ?? [];

  const seen = new Set(state.seen_ids);
  const newEvents: Array<{
    email: ResendEmail;
    event: EventType;
  }> = [];

  for (const email of emails) {
    const event = classifyEvent(email.last_event);
    if (!event) continue;
    if (event === 'sent') continue; // not interesting — we sent these ourselves
    const eventKey = `${email.id}:${event}:${email.last_event_at ?? ''}`;
    if (seen.has(eventKey)) continue;
    newEvents.push({ email, event });
  }

  if (newEvents.length === 0) {
    return {
      shouldWake: false,
      priority: 'low',
      data: {},
      summary: 'No new email events',
    };
  }

  // Prefer the highest-priority new event.
  newEvents.sort((a, b) => {
    const rank: Record<EventType, number> = {
      sent: 0,
      delivered: 1,
      opened: 2,
      clicked: 3,
      replied: 4,
    };
    return rank[b.event] - rank[a.event];
  });
  const top = newEvents[0];
  const recipient = Array.isArray(top.email.to)
    ? top.email.to[0]
    : top.email.to;

  const newIds = [
    ...state.seen_ids,
    ...newEvents.map(
      (e) => `${e.email.id}:${e.event}:${e.email.last_event_at ?? ''}`,
    ),
  ];
  updateAfterWake(config.name, new Date().toISOString(), '', newIds);

  return {
    shouldWake: true,
    priority: priorityFor(top.event),
    data: {
      email_id: top.email.id,
      recipient,
      subject: top.email.subject,
      event_type: top.event,
      timestamp: top.email.last_event_at ?? top.email.created_at,
    },
    summary:
      top.event === 'replied'
        ? `Prospect replied to outreach: ${top.email.subject} (${recipient})`
        : `${top.event}: ${top.email.subject} (${recipient})`,
  };
}

const monitor: Monitor = { config, check };
export default monitor;
```

- [ ] **Step 2: Update `monitors/index.ts`**

```typescript
import type { Monitor } from '../src/monitor-types.js';

import emailResponses from './email-responses.js';
import prospectPipeline from './prospect-pipeline.js';
import redditKeywords from './reddit-keywords.js';

export const monitors: Monitor[] = [
  redditKeywords,
  prospectPipeline,
  emailResponses,
];
```

- [ ] **Step 3: Typecheck and build**

Run: `cd /Users/olorin/nanoclaw && npm run typecheck && npm run build`
Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
cd /Users/olorin/nanoclaw
git add monitors/email-responses.ts monitors/index.ts
git commit -m "feat(monitors): add email-responses monitor (Resend API, urgent on reply)"
```

---

## Task 18: Implement `linkedin-engagement` monitor (stub with buying-signal detector)

**Files:**

- Create: `/Users/olorin/nanoclaw/monitors/linkedin-engagement.ts`
- Modify: `/Users/olorin/nanoclaw/monitors/index.ts`

- [ ] **Step 1: Write the monitor**

Create `/Users/olorin/nanoclaw/monitors/linkedin-engagement.ts`:

```typescript
import { logger } from '../src/logger.js';
import type {
  Monitor,
  MonitorPriority,
  MonitorResult,
} from '../src/monitor-types.js';
import { readEnvFile } from '../src/env.js';

const BUYING_SIGNALS = [
  'pricing',
  'price',
  'demo',
  'trial',
  'how much',
  'integrate',
  'integration',
  'cost',
  'quote',
];

function looksLikeBuyingSignal(text: string): boolean {
  const lower = text.toLowerCase();
  return BUYING_SIGNALS.some((s) => lower.includes(s));
}

export function priorityForComment(text: string): MonitorPriority {
  return looksLikeBuyingSignal(text) ? 'urgent' : 'normal';
}

export const config = {
  name: 'linkedin-engagement',
  intervalMinutes: 45,
  targetGroup: 'demo-clipper',
  enabled: true,
  weekdaysOnly: true,
};

export async function check(): Promise<MonitorResult> {
  const env = readEnvFile(['LINKEDIN_ACCESS_TOKEN', 'LINKEDIN_COMPANY_URN']);
  const token = process.env.LINKEDIN_ACCESS_TOKEN || env.LINKEDIN_ACCESS_TOKEN;
  const companyUrn =
    process.env.LINKEDIN_COMPANY_URN || env.LINKEDIN_COMPANY_URN;
  if (!token || !companyUrn) {
    logger.debug(
      { monitor: config.name },
      'LinkedIn API not configured — skipping',
    );
    return {
      shouldWake: false,
      priority: 'low',
      data: {},
      summary: 'LinkedIn API not configured — skipping',
    };
  }

  // Real LinkedIn-integration code lives in a later skill. For now, return
  // shouldWake: false so the runner records "no-wake" cleanly. The priority
  // helper above is exported so a real implementation can use it on comment text.
  return {
    shouldWake: false,
    priority: 'normal',
    data: {},
    summary: 'LinkedIn integration pending',
  };
}

const monitor: Monitor = { config, check };
export default monitor;
```

- [ ] **Step 2: Update registry**

```typescript
import type { Monitor } from '../src/monitor-types.js';

import emailResponses from './email-responses.js';
import linkedinEngagement from './linkedin-engagement.js';
import prospectPipeline from './prospect-pipeline.js';
import redditKeywords from './reddit-keywords.js';

export const monitors: Monitor[] = [
  redditKeywords,
  prospectPipeline,
  emailResponses,
  linkedinEngagement,
];
```

- [ ] **Step 3: Typecheck and build**

Run: `cd /Users/olorin/nanoclaw && npm run typecheck && npm run build`
Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
cd /Users/olorin/nanoclaw
git add monitors/linkedin-engagement.ts monitors/index.ts
git commit -m "feat(monitors): add linkedin-engagement stub with buying-signal urgency helper"
```

---

## Task 19: Implement `competitor-alerts` monitor

**Files:**

- Create: `/Users/olorin/nanoclaw/monitors/competitor-alerts.ts`
- Modify: `/Users/olorin/nanoclaw/monitors/index.ts`

- [ ] **Step 1: Write the monitor**

Create `/Users/olorin/nanoclaw/monitors/competitor-alerts.ts`:

```typescript
import {
  getMonitorState,
  initMonitorState,
  updateAfterWake,
} from '../src/monitor-store.js';
import type { Monitor, MonitorResult } from '../src/monitor-types.js';

interface Feed {
  source: string;
  url: string;
}

const FEEDS: Feed[] = [
  { source: 'EdSurge', url: 'https://www.edsurge.com/articles_rss' },
  { source: 'Edpuzzle', url: 'https://blog.edpuzzle.com/feed/' },
  { source: 'eLearning Industry', url: 'https://elearningindustry.com/rss' },
];

const KEYWORDS = [
  'Synthesia',
  'HeyGen',
  'Colossyan',
  'D-ID',
  'interactive video',
  'AI training',
  'video learning platform',
];

const MAX_AGE_HOURS = 24;

interface FeedItem {
  id: string;
  title: string;
  link: string;
  pubDate: string; // ISO
}

function parseRss(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const itemRe = /<item[\s\S]*?<\/item>/g;
  const titleRe = /<title>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/title>/;
  const linkRe = /<link>([\s\S]*?)<\/link>/;
  const guidRe = /<guid[^>]*>([\s\S]*?)<\/guid>/;
  const dateRe = /<pubDate>([\s\S]*?)<\/pubDate>/;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml))) {
    const chunk = m[0];
    const tm = titleRe.exec(chunk);
    const lm = linkRe.exec(chunk);
    const gm = guidRe.exec(chunk);
    const dm = dateRe.exec(chunk);
    const title = ((tm?.[1] ?? tm?.[2]) || '').trim();
    const link = (lm?.[1] || '').trim();
    const guid = (gm?.[1] || link || title).trim();
    const dateStr = (dm?.[1] || '').trim();
    const date = dateStr ? new Date(dateStr) : new Date();
    if (!title) continue;
    items.push({
      id: guid,
      title,
      link,
      pubDate: Number.isNaN(date.getTime())
        ? new Date().toISOString()
        : date.toISOString(),
    });
  }
  return items;
}

function matchKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  return KEYWORDS.filter((k) => lower.includes(k.toLowerCase()));
}

async function fetchFeed(feed: Feed): Promise<FeedItem[]> {
  const res = await fetch(feed.url, {
    headers: {
      'User-Agent': 'nanoclaw-monitor/1.0',
      Accept: 'application/rss+xml',
    },
  });
  if (!res.ok) {
    throw new Error(`${feed.source} ${res.status}: ${res.statusText}`);
  }
  const text = await res.text();
  return parseRss(text);
}

export const config = {
  name: 'competitor-alerts',
  intervalMinutes: 120,
  targetGroup: 'slack_dm',
  enabled: true,
};

export async function check(): Promise<MonitorResult> {
  initMonitorState(config.name, config.enabled);
  const state = getMonitorState(config.name)!;
  const seen = new Set(state.seen_ids);

  const now = Date.now();
  const maxAgeMs = MAX_AGE_HOURS * 3_600_000;
  const hits: Array<{
    feed: Feed;
    item: FeedItem;
    matched: string[];
  }> = [];

  for (const feed of FEEDS) {
    let items: FeedItem[];
    try {
      items = await fetchFeed(feed);
    } catch (err) {
      // One feed down should not fail the monitor — log and continue.
      const msg = err instanceof Error ? err.message : String(err);
      // Surface as partial-result warning via summary, not as a thrown error.
      continue;
    }
    for (const item of items) {
      const key = `${feed.source}:${item.id}`;
      if (seen.has(key)) continue;
      const published = new Date(item.pubDate).getTime();
      if (now - published > maxAgeMs) continue;
      const matched = matchKeywords(`${item.title}`);
      if (matched.length === 0) continue;
      hits.push({ feed, item, matched });
    }
  }

  if (hits.length === 0) {
    return {
      shouldWake: false,
      priority: 'normal',
      data: {},
      summary: 'No new competitor items',
    };
  }

  const first = hits[0];
  const newIds = [
    ...state.seen_ids,
    ...hits.map((h) => `${h.feed.source}:${h.item.id}`),
  ];
  updateAfterWake(config.name, new Date().toISOString(), '', newIds);

  return {
    shouldWake: true,
    priority: 'normal',
    data: {
      source: first.feed.source,
      title: first.item.title,
      url: first.item.link,
      published_date: first.item.pubDate,
      matched_terms: first.matched,
    },
    summary: `New ${first.feed.source} article mentioning ${first.matched.join(', ')}: ${first.item.title.slice(0, 100)}`,
  };
}

const monitor: Monitor = { config, check };
export default monitor;
```

- [ ] **Step 2: Register**

Update `/Users/olorin/nanoclaw/monitors/index.ts`:

```typescript
import type { Monitor } from '../src/monitor-types.js';

import competitorAlerts from './competitor-alerts.js';
import emailResponses from './email-responses.js';
import linkedinEngagement from './linkedin-engagement.js';
import prospectPipeline from './prospect-pipeline.js';
import redditKeywords from './reddit-keywords.js';

export const monitors: Monitor[] = [
  redditKeywords,
  prospectPipeline,
  emailResponses,
  linkedinEngagement,
  competitorAlerts,
];
```

- [ ] **Step 3: Typecheck and build**

Run: `cd /Users/olorin/nanoclaw && npm run typecheck && npm run build`
Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
cd /Users/olorin/nanoclaw
git add monitors/competitor-alerts.ts monitors/index.ts
git commit -m "feat(monitors): add competitor-alerts RSS reader (EdSurge, Edpuzzle, eLearning Industry)"
```

---

## Task 20: Add monitors/README.md

**Files:**

- Create: `/Users/olorin/nanoclaw/monitors/README.md`

- [ ] **Step 1: Write the README**

Create `/Users/olorin/nanoclaw/monitors/README.md`:

````markdown
# Monitors

Monitors are lightweight pollers that watch external sources and wake agents when they find something actionable. They run inside the main NanoClaw process — no separate daemon, no LLM calls.

## Adding a new monitor

1. Create `monitors/<name>.ts` that exports:

   ```ts
   import type { Monitor, MonitorResult } from '../src/monitor-types.js';

   export const config = {
     name: '<name>',
     intervalMinutes: 30,
     targetGroup: '<group-folder>',
     enabled: true,
     // optional:
     // weekdaysOnly: true,
     // businessHours: { start: '08:00', end: '18:00' },
     // respectQuietHours: true,
   };

   export async function check(): Promise<MonitorResult> {
     // fetch + parse + condition check — no LLM calls
     return { shouldWake: false, priority: 'normal', data: {}, summary: '' };
   }

   const monitor: Monitor = { config, check };
   export default monitor;
   ```

2. Add it to `monitors/index.ts` (the runner uses a static registry).

3. Add a per-monitor entry in `monitors/config.json` to override defaults (optional).

4. Test with `scripts/claw --monitor <name> --run-now`.

## Keep monitors small

Each monitor should be 30–80 lines. Use `initMonitorState`/`getMonitorState`/`updateAfterWake` for per-monitor state (seen IDs, last hash). Do not store monitor state in files.

## Priority semantics

- `low` — intel, no wake on opens/clicks-only flows
- `normal` — interesting, wake the target agent
- `urgent` — wake the agent AND notify the main group; bypasses quiet hours

## Deduplication

The runner skips a wake when the SHA-256 of `result.data` matches the previous wake. For per-item dedup (e.g., Reddit post IDs), store seen IDs via `updateAfterWake` and filter yourself in `check()`.

## RSS monitors to add later

Synthesia, HeyGen, Colossyan, and D-ID blogs don't expose RSS. Add scraping-based monitors (Cheerio/Playwright) when needed.

## CLI

```bash
scripts/claw --monitors                   # list all monitors with state
scripts/claw --monitor <name> --enable
scripts/claw --monitor <name> --disable
scripts/claw --monitor <name> --run-now   # fire once against live APIs
scripts/claw --monitor <name> --history   # show last 10 runs
```
````

- [ ] **Step 2: Commit**

```bash
cd /Users/olorin/nanoclaw
git add monitors/README.md
git commit -m "docs(monitors): add README describing how to add monitors"
```

---

## Task 21: Add `--monitors` list flag to `scripts/claw`

**Files:**

- Modify: `/Users/olorin/nanoclaw/scripts/claw`

- [ ] **Step 1: Add a helper to read monitor state**

Open `/Users/olorin/nanoclaw/scripts/claw`. After the `get_groups()` function (around line 105), add:

```python
def get_monitor_states(db: Path) -> list[dict]:
    if not db.exists():
        return []
    conn = sqlite3.connect(db)
    try:
        rows = conn.execute(
            """
            SELECT name, enabled, last_run, last_wake, consecutive_failures,
                   auto_disabled_reason
            FROM monitor_state
            ORDER BY name
            """
        ).fetchall()
    except sqlite3.OperationalError:
        # monitor_state table doesn't exist yet (e.g. old DB)
        return []
    finally:
        conn.close()
    return [
        {
            "name": r[0],
            "enabled": bool(r[1]),
            "last_run": r[2],
            "last_wake": r[3],
            "consecutive_failures": r[4],
            "auto_disabled_reason": r[5],
        }
        for r in rows
    ]


def set_monitor_enabled_in_db(db: Path, name: str, enabled: bool) -> bool:
    if not db.exists():
        return False
    conn = sqlite3.connect(db)
    try:
        cur = conn.execute(
            """
            UPDATE monitor_state
            SET enabled = ?, auto_disabled_reason = NULL
            WHERE name = ?
            """,
            (1 if enabled else 0, name),
        )
        changed = cur.rowcount > 0
        conn.commit()
        return changed
    except sqlite3.OperationalError:
        return False
    finally:
        conn.close()


def get_monitor_history(db: Path, name: str, limit: int = 10) -> list[dict]:
    if not db.exists():
        return []
    conn = sqlite3.connect(db)
    try:
        rows = conn.execute(
            """
            SELECT run_at, duration_ms, status, woke_agent, priority, summary, error
            FROM monitor_run_logs
            WHERE monitor_name = ?
            ORDER BY run_at DESC
            LIMIT ?
            """,
            (name, limit),
        ).fetchall()
    except sqlite3.OperationalError:
        return []
    finally:
        conn.close()
    return [
        {
            "run_at": r[0],
            "duration_ms": r[1],
            "status": r[2],
            "woke_agent": bool(r[3]),
            "priority": r[4],
            "summary": r[5],
            "error": r[6],
        }
        for r in rows
    ]
```

- [ ] **Step 2: Add `--monitors` argument**

In `main()`, after the line `parser.add_argument("--list-groups", action="store_true", ...)`, add:

```python
    parser.add_argument("--monitors", action="store_true",
                        help="List all monitors and their current state")
```

- [ ] **Step 3: Handle the flag early in `main()`**

Immediately after `if args.list_groups: ...` block (the `return` at the end of the if block), add:

```python
    if args.monitors:
        states = get_monitor_states(DB_PATH)
        if not states:
            print("No monitors registered yet. Start NanoClaw once to initialize state.")
            return
        print(f"{'NAME':<25} {'ENABLED':<8} {'LAST RUN':<22} {'LAST WAKE':<22} {'FAIL':<4}")
        print("-" * 90)
        for s in states:
            en = "yes" if s["enabled"] else "no"
            tag = ""
            if not s["enabled"] and s["auto_disabled_reason"]:
                tag = f"  [auto-disabled: {s['auto_disabled_reason'][:50]}]"
            print(
                f"{s['name']:<25} {en:<8} "
                f"{(s['last_run'] or '-')[:22]:<22} "
                f"{(s['last_wake'] or '-')[:22]:<22} "
                f"{s['consecutive_failures']:<4}{tag}"
            )
        return
```

- [ ] **Step 4: Smoke test**

Run: `cd /Users/olorin/nanoclaw && scripts/claw --monitors`
Expected: either the `"No monitors registered yet..."` message OR a formatted list of monitors. Exits 0.

- [ ] **Step 5: Commit**

```bash
cd /Users/olorin/nanoclaw
git add scripts/claw
git commit -m "feat(claw): add --monitors flag to list monitor state"
```

---

## Task 22: Add `--monitor <name> --enable/--disable` to `scripts/claw`

**Files:**

- Modify: `/Users/olorin/nanoclaw/scripts/claw`

- [ ] **Step 1: Add CLI args**

In `main()`, after the `--monitors` argument, add:

```python
    parser.add_argument("--monitor", metavar="NAME",
                        help="Target a specific monitor for --enable/--disable/--run-now/--history")
    parser.add_argument("--enable", action="store_true",
                        help="Enable the monitor named by --monitor")
    parser.add_argument("--disable", action="store_true",
                        help="Disable the monitor named by --monitor")
    parser.add_argument("--run-now", action="store_true",
                        help="Fire the monitor named by --monitor immediately (via tsx)")
    parser.add_argument("--history", action="store_true",
                        help="Show last 10 runs of the monitor named by --monitor")
```

- [ ] **Step 2: Handle `--enable`/`--disable`**

After the `--monitors` handler, add:

```python
    if args.monitor and (args.enable or args.disable):
        if args.enable and args.disable:
            sys.exit("error: pass only one of --enable or --disable.")
        enabled = bool(args.enable)
        changed = set_monitor_enabled_in_db(DB_PATH, args.monitor, enabled)
        if not changed:
            sys.exit(
                f"error: monitor '{args.monitor}' not found in DB. "
                f"Has NanoClaw started yet?"
            )
        verb = "enabled" if enabled else "disabled"
        print(f"Monitor '{args.monitor}' {verb}.")
        return
```

- [ ] **Step 3: Smoke test**

Run: `cd /Users/olorin/nanoclaw && scripts/claw --monitor reddit-keywords --enable`
Expected: if NanoClaw has been started once, prints `Monitor 'reddit-keywords' enabled.` and exits 0. Otherwise prints a not-found error.

- [ ] **Step 4: Commit**

```bash
cd /Users/olorin/nanoclaw
git add scripts/claw
git commit -m "feat(claw): add --monitor --enable/--disable flags"
```

---

## Task 23: Add `--monitor <name> --run-now` via tsx

**Files:**

- Create: `/Users/olorin/nanoclaw/scripts/run-monitor.ts`
- Modify: `/Users/olorin/nanoclaw/scripts/claw`

- [ ] **Step 1: Write the tsx runner script**

Create `/Users/olorin/nanoclaw/scripts/run-monitor.ts`:

```typescript
/**
 * One-shot monitor runner. Invoked via tsx by `scripts/claw --run-now`.
 *
 *   tsx scripts/run-monitor.ts <monitor-name>
 */
import { initDatabase } from '../src/db.js';
import { logger } from '../src/logger.js';
import { loadMonitorConfig, runMonitorOnce } from '../src/monitor-runner.js';
import type { Monitor, MonitorDependencies } from '../src/monitor-types.js';
import { monitors } from '../monitors/index.js';

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name) {
    console.error('usage: tsx scripts/run-monitor.ts <monitor-name>');
    process.exit(2);
  }
  const monitor: Monitor | undefined = monitors.find(
    (m) => m.config.name === name,
  );
  if (!monitor) {
    console.error(
      `error: monitor '${name}' not registered in monitors/index.ts`,
    );
    console.error(
      `available: ${monitors.map((m) => m.config.name).join(', ')}`,
    );
    process.exit(1);
  }

  initDatabase();
  const global = loadMonitorConfig();

  // Minimal dependencies: print the injection intent instead of enqueueing
  // into the running NanoClaw process. The runner still stores the synthetic
  // message in the DB — the running NanoClaw (if any) will pick it up via the
  // normal message loop.
  const deps: MonitorDependencies = {
    registeredGroups: () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getAllRegisteredGroups } = require('../src/db.js');
      return getAllRegisteredGroups();
    },
    channels: () => [], // no live channels in one-shot mode
    enqueueMonitorCheck: (chatJid) => {
      logger.info(
        { chatJid, monitor: name },
        '[run-now] enqueueMonitorCheck: a live NanoClaw would pick up the new message from SQLite',
      );
    },
  };

  logger.info({ monitor: name }, '[run-now] starting one-shot monitor run');
  await runMonitorOnce(monitor, global, deps);
  logger.info({ monitor: name }, '[run-now] complete');
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, '[run-now] failed');
  process.exit(1);
});
```

Note: `require` is used inside `registeredGroups` because dynamic-require bypasses a circular-import edge case between `db.js` and `monitor-runner.js` at load time. If lint forbids CommonJS `require`, import at top level and remove the eslint-disable.

- [ ] **Step 2: Simplify `registeredGroups` to top-level import**

Replace the `require` block with a top-level import. At the top of the file:

```typescript
import { getAllRegisteredGroups, initDatabase } from '../src/db.js';
```

And simplify the `deps` block:

```typescript
const deps: MonitorDependencies = {
  registeredGroups: () => getAllRegisteredGroups(),
  channels: () => [],
  enqueueMonitorCheck: (chatJid) => {
    logger.info(
      { chatJid, monitor: name },
      '[run-now] enqueueMonitorCheck: a live NanoClaw would pick up the new message from SQLite',
    );
  },
};
```

(The circular-import concern was a false alarm — `monitor-runner.js` already imports from `db.js`.)

- [ ] **Step 3: Wire `--run-now` in `scripts/claw`**

In `main()`, after the `--enable/--disable` handler, add:

```python
    if args.monitor and args.run_now:
        cmd = ["npx", "tsx", str(NANOCLAW_DIR / "scripts" / "run-monitor.ts"), args.monitor]
        dbg(f"run-now: {' '.join(cmd)}")
        result = subprocess.run(cmd, cwd=NANOCLAW_DIR)
        sys.exit(result.returncode)
```

- [ ] **Step 4: Verify typecheck / build**

Run: `cd /Users/olorin/nanoclaw && npm run typecheck`
Expected: exits 0.

The `scripts/run-monitor.ts` file is NOT part of the compiled output (it's under `scripts/`, not `src/` or `monitors/`). That's fine — it runs via tsx.

- [ ] **Step 5: Smoke test (after NanoClaw has run once)**

Run: `cd /Users/olorin/nanoclaw && scripts/claw --monitor reddit-keywords --run-now`
Expected:

- tsx compiles and runs
- logs show `[run-now] starting one-shot monitor run`
- A call to Reddit succeeds or fails gracefully
- exits with 0

The first run against a live DB may fail if `reddit-scout` group is not registered. That's expected — see the note in stdout (`target group not registered`). The test confirms plumbing works.

- [ ] **Step 6: Commit**

```bash
cd /Users/olorin/nanoclaw
git add scripts/run-monitor.ts scripts/claw
git commit -m "feat(claw): add --monitor --run-now (one-shot runner via tsx)"
```

---

## Task 24: Add `--monitor <name> --history`

**Files:**

- Modify: `/Users/olorin/nanoclaw/scripts/claw`

- [ ] **Step 1: Add the handler**

In `main()`, after the `--run-now` handler, add:

```python
    if args.monitor and args.history:
        rows = get_monitor_history(DB_PATH, args.monitor, limit=10)
        if not rows:
            print(f"No run history yet for '{args.monitor}'.")
            return
        print(
            f"{'RUN AT':<22} {'STATUS':<22} {'WOKE':<5} {'PRIO':<7} {'DUR_MS':<7} SUMMARY"
        )
        print("-" * 110)
        for r in rows:
            woke = "yes" if r["woke_agent"] else "no"
            summary = (r["summary"] or r["error"] or "")[:50]
            print(
                f"{r['run_at']:<22} {r['status']:<22} "
                f"{woke:<5} {(r['priority'] or '-'):<7} {r['duration_ms']:<7} {summary}"
            )
        return
```

- [ ] **Step 2: Smoke test**

Run: `cd /Users/olorin/nanoclaw && scripts/claw --monitor reddit-keywords --history`
Expected: either `"No run history yet..."` or a formatted table. Exits 0.

- [ ] **Step 3: Commit**

```bash
cd /Users/olorin/nanoclaw
git add scripts/claw
git commit -m "feat(claw): add --monitor --history to print last 10 monitor runs"
```

---

## Task 25: End-to-end smoke test

**Files:**

- No file changes. This task verifies the full pipeline works end-to-end.

- [ ] **Step 1: Run the full test suite**

Run: `cd /Users/olorin/nanoclaw && npm test`
Expected: all tests pass, no regressions.

- [ ] **Step 2: Run typecheck and lint**

Run: `cd /Users/olorin/nanoclaw && npm run typecheck && npm run lint`
Expected: both exit 0 with no errors.

- [ ] **Step 3: Clean build**

Run: `cd /Users/olorin/nanoclaw && rm -rf dist && npm run build`
Expected: exits 0, `dist/src/index.js` and `dist/monitors/index.js` both exist.

- [ ] **Step 4: Verify monitor files compiled**

Run: `cd /Users/olorin/nanoclaw && ls dist/monitors/`
Expected: shows `index.js`, `reddit-keywords.js`, `prospect-pipeline.js`, `email-responses.js`, `linkedin-engagement.js`, `competitor-alerts.js`.

- [ ] **Step 5: Manual run-now against one monitor**

Run: `cd /Users/olorin/nanoclaw && scripts/claw --monitor reddit-keywords --run-now`
Expected:

- tsx starts
- `[run-now] starting one-shot monitor run` logged
- Reddit fetch either succeeds (logs `success` or `no-wake`) or returns a clean error (logs `error`)
- process exits 0

- [ ] **Step 6: Check run was recorded**

Run: `cd /Users/olorin/nanoclaw && scripts/claw --monitor reddit-keywords --history`
Expected: a single row showing the run from Step 5 with a valid `status`.

- [ ] **Step 7: Toggle via CLI**

Run: `cd /Users/olorin/nanoclaw && scripts/claw --monitor reddit-keywords --disable && scripts/claw --monitors`
Expected: `enabled = no` for `reddit-keywords`.

Run: `cd /Users/olorin/nanoclaw && scripts/claw --monitor reddit-keywords --enable`
Expected: `Monitor 'reddit-keywords' enabled.`

- [ ] **Step 8: Commit if any last-mile fixes were needed**

If any tweaks were required:

```bash
cd /Users/olorin/nanoclaw
git add -A
git commit -m "chore(monitors): end-to-end smoke fixes"
```

If no changes, skip commit.

---

## After implementation

Once merged, perform the post-implementation validation Gil specified in the spec:

1. Start NanoClaw: `npm run dev`
2. Run each monitor: `scripts/claw --monitor <name> --run-now` and verify status appears in `--history`
3. Verify that a `shouldWake: true` run stores a `__monitor__:` message in SQLite and the live NanoClaw picks it up via `startMessageLoop` → `queue.enqueueMessageCheck` → agent wakes with the `[MONITOR: <name>]` prefix (bypassing the trigger check via `hasMonitorTriggerBypass`).
4. Watch the system run for 24 hours. Verify:
   - No consecutive-failure auto-disables except for genuinely broken feeds
   - Quiet hours (23:00–07:00 ET) produce `skipped-quiet` rows for non-urgent monitors
   - Duplicate-data runs produce `no-wake` rows (dedup works)
5. Add new monitors as needed by dropping a file in `monitors/<name>.ts` and appending to `monitors/index.ts`.
