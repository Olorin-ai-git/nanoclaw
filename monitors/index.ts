import type { Monitor } from '../src/monitor-types.js';

import competitorAlerts from './competitor-alerts.js';
import emailResponses from './email-responses.js';
import linkedinEngagement from './linkedin-engagement.js';
import prospectPipeline from './prospect-pipeline.js';
import redditKeywords from './reddit-keywords.js';

export const monitors: Monitor[] = [
  redditKeywords,
  prospectPipeline,
  emailResponses,
  linkedinEngagement,
  competitorAlerts,
];
