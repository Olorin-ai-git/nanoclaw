import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, setRegisteredGroup } from './db.js';
import {
  computeDataHash,
  getLoadedGlobalConfig,
  injectMonitorMessage,
  loadMonitorConfig,
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
  MonitorResult,
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
  it('hashes equivalent nested objects identically regardless of key order', () => {
    const a = { a: { z: 1, b: 2 }, x: [1, 2, 3] };
    const b = { x: [1, 2, 3], a: { b: 2, z: 1 } };
    expect(computeDataHash(a)).toBe(computeDataHash(b));
  });
  it('does not treat reordered arrays as equivalent', () => {
    expect(computeDataHash({ items: [1, 2, 3] })).not.toBe(
      computeDataHash({ items: [3, 2, 1] }),
    );
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
      // This check never resolves within the 30s timeout window; the
      // `resolve` binding is only invoked by the pending setTimeout at
      // 60s, which the timeout path preempts.
      check: () =>
        new Promise<MonitorResult>((resolve) =>
          setTimeout(() => resolve({} as MonitorResult), 60_000),
        ),
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

  it('getLoadedGlobalConfig returns the last-loaded config including extras', () => {
    const tmp = path.join(
      os.tmpdir(),
      `monitor-config-${crypto.randomUUID()}.json`,
    );
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        enabled: true,
        defaultIntervalMinutes: 30,
        maxConcurrentMonitors: 3,
        quietHours: {
          start: '23:00',
          end: '07:00',
          timezone: 'America/New_York',
        },
        monitors: {
          'test-monitor': { extras: { keywords: ['foo', 'bar'] } },
        },
      }),
    );
    loadMonitorConfig(tmp);
    const loaded = getLoadedGlobalConfig();
    expect(loaded?.monitors['test-monitor']?.extras?.keywords).toEqual([
      'foo',
      'bar',
    ]);
    fs.unlinkSync(tmp);
  });

  it('preserves seen_ids that the monitor persisted during check()', async () => {
    const enqueued: string[] = [];
    const deps = fakeDeps(enqueued, fakeChannel());

    // Monitor writes its own seen_ids via the store during check().
    const m: Monitor = {
      config: {
        name: 'stateful',
        intervalMinutes: 20,
        targetGroup: 'reddit-scout',
        enabled: true,
      },
      check: async () => {
        // Use the store directly — this is how real monitors dedupe per-item.
        const store = await import('./monitor-store.js');
        store.initMonitorState('stateful', true);
        store.updateAfterWake('stateful', '2026-04-13T14:59:00.000Z', '', [
          'post-1',
          'post-2',
        ]);
        return {
          shouldWake: true,
          priority: 'normal',
          data: { post: 'post-1' },
          summary: 'hit',
        };
      },
    };

    await runMonitorOnce(
      m,
      baseGlobal(),
      deps,
      new Date('2026-04-13T15:00:00.000Z'),
    );

    const finalState = getMonitorState('stateful')!;
    // Runner must preserve the monitor's seen_ids update, not overwrite it.
    expect(finalState.seen_ids).toEqual(['post-1', 'post-2']);
  });
});
