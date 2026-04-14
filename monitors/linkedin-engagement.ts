import { logger } from '../src/logger.js';
import type {
  Monitor,
  MonitorPriority,
  MonitorResult,
} from '../src/monitor-types.js';
import { readEnvFile } from '../src/env.js';

const BUYING_SIGNALS = [
  'pricing',
  'price',
  'demo',
  'trial',
  'how much',
  'integrate',
  'integration',
  'cost',
  'quote',
];

function looksLikeBuyingSignal(text: string): boolean {
  const lower = text.toLowerCase();
  return BUYING_SIGNALS.some((s) => lower.includes(s));
}

export function priorityForComment(text: string): MonitorPriority {
  return looksLikeBuyingSignal(text) ? 'urgent' : 'normal';
}

export const config = {
  name: 'linkedin-engagement',
  intervalMinutes: 45,
  targetGroup: 'demo-clipper',
  enabled: true,
  weekdaysOnly: true,
};

export async function check(): Promise<MonitorResult> {
  const env = readEnvFile(['LINKEDIN_ACCESS_TOKEN', 'LINKEDIN_COMPANY_URN']);
  const token = process.env.LINKEDIN_ACCESS_TOKEN || env.LINKEDIN_ACCESS_TOKEN;
  const companyUrn =
    process.env.LINKEDIN_COMPANY_URN || env.LINKEDIN_COMPANY_URN;
  if (!token || !companyUrn) {
    logger.debug(
      { monitor: config.name },
      'LinkedIn API not configured — skipping',
    );
    return {
      shouldWake: false,
      priority: 'low',
      data: {},
      summary: 'LinkedIn API not configured — skipping',
    };
  }

  // Real LinkedIn-integration code lives in a later skill. For now, return
  // shouldWake: false so the runner records "no-wake" cleanly. The priority
  // helper above is exported so a real implementation can use it on comment text.
  return {
    shouldWake: false,
    priority: 'normal',
    data: {},
    summary: 'LinkedIn integration pending',
  };
}

const monitor: Monitor = { config, check };
export default monitor;
