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
      // Secondary sort by id DESC so rows inserted in the same millisecond
      // still come back in insertion order (most recent first).
      `SELECT monitor_name, run_at, duration_ms, status, woke_agent, priority, summary, error
       FROM monitor_run_logs
       WHERE monitor_name = ?
       ORDER BY run_at DESC, id DESC
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
