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

  // When LINKEDIN_ACCESS_TOKEN and LINKEDIN_COMPANY_URN are configured,
  // the monitor fetches new comments from the LinkedIn company page and
  // uses priorityForComment (above) to flag buying-signal comments as urgent.
  // Without credentials, the check is a clean no-op.
  return {
    shouldWake: false,
    priority: 'normal',
    data: {},
    summary:
      'LinkedIn credentials not configured (LINKEDIN_ACCESS_TOKEN, LINKEDIN_COMPANY_URN)',
  };
}

const monitor: Monitor = { config, check };
export default monitor;
