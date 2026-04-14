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
      data: { ...summary },
      summary: 'Pipeline healthy',
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  const alertKey = `${ALERT_KEY_PREFIX}${today}`;
  if (state.seen_ids.includes(alertKey)) {
    return {
      shouldWake: false,
      priority: 'normal',
      data: { ...summary },
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
