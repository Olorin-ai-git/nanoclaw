import type { Monitor } from '../src/monitor-types.js';

import prospectPipeline from './prospect-pipeline.js';
import redditKeywords from './reddit-keywords.js';

export const monitors: Monitor[] = [redditKeywords, prospectPipeline];
