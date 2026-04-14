import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined) and bot messages
// (BotMessageEvent, subtype 'bot_message') so we can track our own output.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /** Channel name and JID prefix (default: 'slack') */
  channelName?: string;
  /** Env var name for the bot token (default: 'SLACK_BOT_TOKEN') */
  botTokenEnv?: string;
  /** Env var name for the app token (default: 'SLACK_APP_TOKEN') */
  appTokenEnv?: string;
}

export class SlackChannel implements Channel {
  name: string;

  private jidPrefix: string;
  private app: App;
  private botUserId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  /** Track the latest thread_ts per channel so replies go into the thread */
  private lastThreadTs = new Map<string, string>();

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;
    this.name = opts.channelName || 'slack';
    this.jidPrefix = this.name;

    const botTokenKey = opts.botTokenEnv || 'SLACK_BOT_TOKEN';
    const appTokenKey = opts.appTokenEnv || 'SLACK_APP_TOKEN';

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile([botTokenKey, appTokenKey]);
    const botToken = env[botTokenKey];
    const appToken = env[appTokenKey];

    if (!botToken || !appToken) {
      throw new Error(`${botTokenKey} and ${appTokenKey} must be set in .env`);
    }

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    this.app.event('message', async ({ event }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We filter on subtype first, then narrow to the two types we handle.
      const subtype = (event as { subtype?: string }).subtype;
      if (subtype && subtype !== 'bot_message') return;

      // After filtering, event is either GenericMessageEvent or BotMessageEvent
      const msg = event as HandledMessageEvent;

      if (!msg.text) return;

      // Route threaded messages to thread-specific groups when registered.
      // If a message is in a thread and a group is registered with a
      // thread-based JID (prefix:channel:thread:ts), route there.
      // Otherwise fall through to the channel-level group.

      const channelJid = `${this.jidPrefix}:${msg.channel}`;
      const threadTs = (msg as any).thread_ts as string | undefined;
      const threadJid = threadTs
        ? `${this.jidPrefix}:${msg.channel}:thread:${threadTs}`
        : undefined;

      const groups = this.opts.registeredGroups();
      const jid = threadJid && groups[threadJid] ? threadJid : channelJid;

      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, this.name, isGroup);

      // Only deliver full messages for registered groups
      if (!groups[jid]) return;

      const isBotMessage = !!msg.bot_id || msg.user === this.botUserId;

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot is @mentioned.
      let content = msg.text;
      if (this.botUserId && !isBotMessage) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (
          content.includes(mentionPattern) &&
          !TRIGGER_PATTERN.test(content)
        ) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Track thread context: if the message is in a thread, use its thread_ts;
      // otherwise use the message's own ts as the thread parent for replies.
      if (!isBotMessage) {
        const threadTs = (msg as any).thread_ts || msg.ts;
        this.lastThreadTs.set(jid, threadTs);
      }

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
      });
    });
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  /**
   * Parse a JID into its channel ID and optional thread_ts.
   * Thread JIDs have the format: prefix:channelId:thread:timestamp
   */
  private parseJid(jid: string): { channelId: string; threadTs?: string } {
    const stripped = jid.replace(new RegExp(`^${this.jidPrefix}:`), '');
    const threadMatch = stripped.match(/^([^:]+):thread:(.+)$/);
    if (threadMatch) {
      return { channelId: threadMatch[1], threadTs: threadMatch[2] };
    }
    return { channelId: stripped };
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const { channelId, threadTs: jidThreadTs } = this.parseJid(jid);

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      // For thread-based JIDs, always reply in that thread.
      // Otherwise use tracked thread context from the last inbound message.
      const threadTs = jidThreadTs || this.lastThreadTs.get(jid);

      // Slack limits messages to ~4000 characters; split if needed
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text,
          thread_ts: threadTs,
        });
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: text.slice(i, i + MAX_MESSAGE_LENGTH),
            thread_ts: threadTs,
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(`${this.jidPrefix}:`);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  // Slack does not expose a typing indicator API for bots.
  // This no-op satisfies the Channel interface so the orchestrator
  // doesn't need channel-specific branching.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Slack Bot API has no typing indicator endpoint
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`${this.jidPrefix}:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const parsed = this.parseJid(item.jid);
        await this.app.client.chat.postMessage({
          channel: parsed.channelId,
          text: item.text,
          thread_ts: parsed.threadTs,
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});

registerChannel('slack-saruman', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'SLACK_SARUMAN_BOT_TOKEN',
    'SLACK_SARUMAN_APP_TOKEN',
  ]);
  if (!envVars.SLACK_SARUMAN_BOT_TOKEN || !envVars.SLACK_SARUMAN_APP_TOKEN) {
    logger.debug('Slack (Saruman): tokens not set, skipping');
    return null;
  }
  return new SlackChannel({
    ...opts,
    channelName: 'slack-saruman',
    botTokenEnv: 'SLACK_SARUMAN_BOT_TOKEN',
    appTokenEnv: 'SLACK_SARUMAN_APP_TOKEN',
  });
});
