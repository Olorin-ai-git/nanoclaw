# Slack "thinking..." placeholder indicator

**Goal:** Give Slack users visual feedback that a bot (Olorin, Saruman, Radagast) is processing their message — currently there is a dead-silent 10–120s gap between user input and bot reply.

**Approach:** Post a `💭 _thinking..._` placeholder message when the orchestrator begins processing, then `chat.update` that same message to contain the real reply when the agent finishes. If the agent produces no output, `chat.delete` the placeholder. This avoids reconfiguring the Slack app as an AI Assistant (which would require scope changes + manifest edits for every bot).

**Scope:** Slack channel only. WhatsApp/Telegram unaffected.

## Hook points (no orchestrator changes)

`src/index.ts` already calls `channel.setTyping?.(chatJid, true)` at line 347 before `runAgent`, and `channel.setTyping?.(chatJid, false)` at line 379 after. The full implementation lives inside `src/channels/slack.ts`:

- **`setTyping(jid, true)`** — post a placeholder message in the current channel+thread; store its `ts` in a per-JID map.
- **`sendMessage(jid, text)`** — if a placeholder exists for this JID, `chat.update` it with `text` and pop the entry; otherwise post normally. Multi-chunk messages (>4000 chars): first chunk updates, rest post new.
- **`setTyping(jid, false)`** — if a placeholder is still pending (agent produced no output), `chat.delete` it.

## Implementation sketch

```ts
// New private state
private pendingPlaceholders = new Map<string, { channel: string; ts: string }>();
private readonly PLACEHOLDER_TEXT = '💭 _thinking…_';

async setTyping(jid: string, isTyping: boolean): Promise<void> {
  if (!this.connected) return;
  const { channelId, threadTs: jidThreadTs } = this.parseJid(jid);
  const threadTs = jidThreadTs ?? this.lastThreadTs.get(jid);

  if (isTyping) {
    if (this.pendingPlaceholders.has(jid)) return; // already posted
    try {
      const res = await this.app.client.chat.postMessage({
        channel: channelId, text: this.PLACEHOLDER_TEXT, thread_ts: threadTs,
      });
      if (res.ts) this.pendingPlaceholders.set(jid, { channel: channelId, ts: res.ts });
    } catch (err) {
      logger.debug({ jid, err }, 'Slack placeholder post failed (non-fatal)');
    }
  } else {
    const ph = this.pendingPlaceholders.get(jid);
    if (!ph) return;
    this.pendingPlaceholders.delete(jid);
    try {
      await this.app.client.chat.delete({ channel: ph.channel, ts: ph.ts });
    } catch (err) {
      logger.debug({ jid, err }, 'Slack placeholder delete failed (non-fatal)');
    }
  }
}

async sendMessage(jid: string, text: string): Promise<void> {
  const { channelId, threadTs: jidThreadTs } = this.parseJid(jid);
  if (!this.connected) { /* existing queue path */ return; }

  const threadTs = jidThreadTs || this.lastThreadTs.get(jid);
  const placeholder = this.pendingPlaceholders.get(jid);
  this.pendingPlaceholders.delete(jid); // consume exactly once

  try {
    if (text.length <= MAX_MESSAGE_LENGTH) {
      if (placeholder) {
        await this.app.client.chat.update({ channel: placeholder.channel, ts: placeholder.ts, text });
      } else {
        await this.app.client.chat.postMessage({ channel: channelId, text, thread_ts: threadTs });
      }
    } else {
      const firstChunk = text.slice(0, MAX_MESSAGE_LENGTH);
      if (placeholder) {
        await this.app.client.chat.update({ channel: placeholder.channel, ts: placeholder.ts, text: firstChunk });
      } else {
        await this.app.client.chat.postMessage({ channel: channelId, text: firstChunk, thread_ts: threadTs });
      }
      for (let i = MAX_MESSAGE_LENGTH; i < text.length; i += MAX_MESSAGE_LENGTH) {
        await this.app.client.chat.postMessage({
          channel: channelId, text: text.slice(i, i + MAX_MESSAGE_LENGTH), thread_ts: threadTs,
        });
      }
    }
  } catch (err) {
    // existing queue-on-failure path; if we had a placeholder it's already lost, fall back to postMessage
    this.outgoingQueue.push({ jid, text });
    logger.warn({ jid, err }, 'Slack send failed, queued');
  }
}
```

## Tests

`src/channels/slack.ts` has no dedicated test file today (it's a thin wrapper around Bolt). The existing test suite exercises messaging through the `Channel` interface. I'll add a new `src/channels/slack.test.ts` with mocked `app.client` covering:

1. `setTyping(jid, true)` calls `chat.postMessage` with the placeholder text + correct thread_ts.
2. Repeated `setTyping(jid, true)` doesn't post again while one is pending.
3. `sendMessage(jid, short)` after `setTyping(true)` calls `chat.update`, not `postMessage`.
4. `sendMessage(jid, long)` after `setTyping(true)` updates the placeholder with first chunk and posts remaining chunks.
5. `setTyping(jid, false)` with no sendMessage in between calls `chat.delete`.
6. `setTyping(jid, false)` after `sendMessage` is a no-op (placeholder consumed).
7. `sendMessage` without prior `setTyping(true)` posts normally — no update call.

## Out of scope

- Telegram typing indicator (Telegram Bot API has `sendChatAction` — separate task if wanted).
- Switching Slack apps to AI Assistant mode.
- Changing the placeholder text based on which bot (could template per-channel later).

## Branch / verification

- Branch: `feature/slack-thinking-placeholder` off main.
- Verify: build + tests, then restart service and send a test message that takes >2s to respond in each Slack surface: DM, channel thread, main channel.
