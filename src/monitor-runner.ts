import crypto from 'crypto';
import fs from 'fs';

import { MONITOR_CONFIG_PATH } from './config.js';
import { storeChatMetadata, storeMonitorMessage } from './db.js';
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

export const MONITOR_SENDER_PREFIX = '__monitor__:';

export function hasMonitorTriggerBypass(msg: {
  sender: string;
  is_bot_message?: boolean;
}): boolean {
  if (msg.is_bot_message) return false;
  return msg.sender.startsWith(MONITOR_SENDER_PREFIX);
}

export function computeDataHash(data: unknown): string {
  // Sort keys for stable hashing — same payload produces same hash
  // regardless of object key insertion order.
  const canonical = JSON.stringify(data, (_, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[key] = (v as Record<string, unknown>)[key];
      }
      return sorted;
    }
    return v;
  });
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

  const timestamp = new Date().toISOString();

  // Ensure the chat row exists — storeMessage has a FK on chat_jid → chats.jid.
  // During normal operation the chat row is created by channel intake; this
  // guards synthetic monitor injection against fresh databases.
  storeChatMetadata(chatJid, timestamp);

  const msg: NewMessage = {
    id: `monitor-${monitorName}-${crypto.randomUUID()}`,
    chat_jid: chatJid,
    sender: `${MONITOR_SENDER_PREFIX}${monitorName}`,
    sender_name: `Monitor (${monitorName})`,
    content,
    timestamp,
    is_from_me: false,
    is_bot_message: false,
  };
  storeMonitorMessage(msg);
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

type TimingGate =
  | { allowed: true; reason: 'ok' }
  | {
      allowed: false;
      reason: 'skipped-quiet' | 'skipped-weekday' | 'skipped-business-hours';
    };

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

type WithTimeoutResult<T> =
  | { ok: true; value: T }
  | { ok: false; timedOut: true }
  | { ok: false; err: unknown };

function withTimeout<T>(
  p: Promise<T>,
  ms: number,
): Promise<WithTimeoutResult<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ ok: false, timedOut: true });
    }, ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      (err) => {
        clearTimeout(timer);
        resolve({ ok: false, err });
      },
    );
  });
}

async function maybeNotifyAutoDisable(
  name: string,
  failures: number,
  reason: string,
  deps: MonitorDependencies,
): Promise<void> {
  if (failures < FAILURE_LIMIT) return;
  autoDisableMonitor(name, reason);
  try {
    await sendToMain(
      deps,
      `Monitor [${name}] auto-disabled after ${FAILURE_LIMIT} consecutive failures: ${reason}`,
    );
  } catch (err) {
    logger.warn(
      { monitor: name, err },
      'Failed to notify main about auto-disable',
    );
  }
}

async function handleCheckFailure(
  monitor: Monitor,
  errMsg: string,
  runAt: string,
  durationMs: number,
  deps: MonitorDependencies,
): Promise<void> {
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
  await maybeNotifyAutoDisable(monitor.config.name, failures, errMsg, deps);
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
  // `now` drives timing gates (quiet hours, business hours) so tests can pin
  // a specific local time. `runAt` is the actual wall-clock when we log —
  // this decouples the two so repeated runs with the same `now` still produce
  // monotonically-ordered log rows.
  const runAt = new Date().toISOString();

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

  const started = Date.now();
  const timed = await withTimeout(monitor.check(), CHECK_TIMEOUT_MS);

  if (!timed.ok && 'timedOut' in timed) {
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
    await maybeNotifyAutoDisable(
      name,
      failures,
      `timeout after ${CHECK_TIMEOUT_MS}ms`,
      deps,
    );
    updateAfterRun(name, runAt);
    return;
  }

  if (!timed.ok) {
    const errMsg =
      timed.err instanceof Error ? timed.err.message : String(timed.err);
    await handleCheckFailure(
      monitor,
      errMsg,
      runAt,
      Date.now() - started,
      deps,
    );
    updateAfterRun(name, runAt);
    return;
  }

  const result = timed.value;
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

  // Re-read state — monitors may persist their own seen_ids during check().
  // Using the pre-check `state.seen_ids` here would clobber the monitor's update.
  const latest = getMonitorState(name) ?? state;
  updateAfterWake(name, runAt, dataHash, latest.seen_ids);
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

let loadedGlobal: MonitorGlobalConfig | null = null;

export function getLoadedGlobalConfig(): MonitorGlobalConfig | null {
  return loadedGlobal;
}

export function loadMonitorConfig(pathOverride?: string): MonitorGlobalConfig {
  const p = pathOverride ?? MONITOR_CONFIG_PATH;
  if (!fs.existsSync(p)) {
    logger.info({ path: p }, 'No monitor config file — using defaults');
    loadedGlobal = DEFAULT_GLOBAL;
    return loadedGlobal;
  }
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<MonitorGlobalConfig>;
    loadedGlobal = {
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
    return loadedGlobal;
  } catch (err) {
    logger.warn(
      { path: p, err },
      'Failed to parse monitor config — using defaults',
    );
    loadedGlobal = DEFAULT_GLOBAL;
    return loadedGlobal;
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
const staggerTimers = new Map<string, NodeJS.Timeout>();

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
        'Stale monitor state in DB (file removed). Preserved for history; will be inert.',
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
    // Stagger is deterministic (hash of monitor name) so startup-timing bugs
    // are reproducible across restarts — same name always maps to the same offset.
    const digest = crypto
      .createHash('sha1')
      .update(merged.config.name)
      .digest();
    const offset = digest.readUInt16BE(0) % 15_000;
    const stagger = 5_000 + offset;
    const staggerTimer = setTimeout(() => {
      staggerTimers.delete(merged.config.name);
      fire();
    }, stagger);
    staggerTimers.set(merged.config.name, staggerTimer);

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
