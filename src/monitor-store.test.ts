import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from './db.js';
import {
  autoDisableMonitor,
  getAllMonitorStates,
  getMonitorHistory,
  getMonitorState,
  initMonitorState,
  logMonitorRun,
  recordFailure,
  resetFailures,
  setMonitorEnabled,
  updateAfterRun,
  updateAfterWake,
  updateSeenIds,
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
    recordFailure('m');
    recordFailure('m');
    recordFailure('m');
    autoDisableMonitor('m', 'Network unreachable');
    const state = getMonitorState('m')!;
    expect(state.enabled).toBe(false);
    expect(state.auto_disabled_reason).toBe('Network unreachable');
    expect(state.consecutive_failures).toBe(0);
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

  it('getAllMonitorStates returns all monitors in alphabetical order', () => {
    initMonitorState('zeta', true);
    initMonitorState('alpha', false);
    initMonitorState('mike', true);
    const all = getAllMonitorStates();
    expect(all.map((s) => s.name)).toEqual(['alpha', 'mike', 'zeta']);
    expect(all[0].enabled).toBe(false);
    expect(all[1].enabled).toBe(true);
  });

  it('recordFailure returns the new failure count', () => {
    initMonitorState('m', true);
    expect(recordFailure('m')).toBe(1);
    expect(recordFailure('m')).toBe(2);
    expect(recordFailure('m')).toBe(3);
  });

  it('updateSeenIds writes only seen_ids and leaves wake metadata untouched', () => {
    initMonitorState('m', true);
    const wakeTs = '2026-04-13T10:00:00.000Z';
    updateAfterWake('m', wakeTs, 'hash-abc', ['a', 'b']);
    updateSeenIds('m', ['a', 'b', 'c']);
    const state = getMonitorState('m')!;
    expect(state.seen_ids).toEqual(['a', 'b', 'c']);
    expect(state.last_wake).toBe(wakeTs);
    expect(state.last_data_hash).toBe('hash-abc');
  });

  it('updateSeenIds caps at 500 entries (oldest first dropped)', () => {
    initMonitorState('m', true);
    const ids = Array.from({ length: 600 }, (_, i) => `id-${i}`);
    updateSeenIds('m', ids);
    const stored = getMonitorState('m')!.seen_ids;
    expect(stored).toHaveLength(500);
    expect(stored[0]).toBe('id-100');
    expect(stored[499]).toBe('id-599');
  });
});
