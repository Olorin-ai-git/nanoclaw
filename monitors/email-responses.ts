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
  const newEvents: Array<{ email: ResendEmail; event: EventType }> = [];

  for (const email of emails) {
    const event = classifyEvent(email.last_event);
    if (!event) continue;
    if (event === 'sent') continue;
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
