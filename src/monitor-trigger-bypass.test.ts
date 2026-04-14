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
  it('returns false for bot messages even with __monitor__ sender', () => {
    expect(
      hasMonitorTriggerBypass(
        msg({ sender: '__monitor__:x', is_bot_message: true }),
      ),
    ).toBe(false);
  });
});
