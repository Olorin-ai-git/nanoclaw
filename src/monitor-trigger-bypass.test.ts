import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  getDb,
  getNewMessages,
  storeMessage,
  storeMonitorMessage,
} from './db.js';
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
  it('returns false for bot messages even with __monitor__ sender', () => {
    expect(
      hasMonitorTriggerBypass(
        msg({ sender: '__monitor__:x', is_bot_message: true }),
      ),
    ).toBe(false);
  });
});

describe('storeMessage / storeMonitorMessage sender guards', () => {
  beforeEach(() => {
    _initTestDatabase();
    // Seed the chats row so FK is satisfied for any message insertions.
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
      )
      .run('fake:g', 'fake', '2026-04-13T00:00:00.000Z');
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('storeMessage throws for __monitor__: sender and does NOT insert the row', () => {
    const m = msg({ id: 'guard-test-1', sender: '__monitor__:evil' });

    expect(() => storeMessage(m)).toThrow(
      /storeMessage: refusing to write sender "__monitor__:evil"/,
    );

    // Confirm no row was inserted.
    const row = getDb()
      .prepare(`SELECT id FROM messages WHERE id = ?`)
      .get('guard-test-1');
    expect(row).toBeUndefined();
  });

  it('storeMonitorMessage succeeds and the row is visible via getNewMessages', () => {
    const ts = '2026-04-13T10:00:00.000Z';
    const m = msg({
      id: 'monitor-msg-1',
      sender: '__monitor__:test-monitor',
      timestamp: ts,
    });

    storeMonitorMessage(m);

    // getNewMessages filters out is_bot_message rows, but monitor messages
    // have is_bot_message = false, so they should appear.
    const before = new Date(new Date(ts).getTime() - 1).toISOString();
    const { messages } = getNewMessages(['fake:g'], before, 'Bot', 10);
    expect(messages.some((r) => r.id === 'monitor-msg-1')).toBe(true);
  });
});
