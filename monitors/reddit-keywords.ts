import { logger } from '../src/logger.js';
import {
  getMonitorState,
  initMonitorState,
  updateAfterWake,
} from '../src/monitor-store.js';
import type { Monitor, MonitorResult } from '../src/monitor-types.js';

const SUBREDDITS = 'elearning+instructionaldesign+edtech+corporatetraining';
const FEED_URL = `https://www.reddit.com/r/${SUBREDDITS}/new.json?limit=50`;
const MAX_AGE_HOURS = 4;
const USER_AGENT = 'nanoclaw-monitor/1.0';

const KEYWORDS = [
  'interactive video',
  'training video engagement',
  'video completion rate',
  'boring training',
  'compliance training',
  'AI training',
  'edtech tool',
  'Synthesia alternative',
  'HeyGen alternative',
  'training LMS',
  'onboarding video',
  'video learning',
];

interface RedditPost {
  id: string;
  title: string;
  subreddit: string;
  url: string;
  permalink: string;
  author: string;
  created_utc: number;
  selftext: string;
}

interface RedditResponse {
  data?: { children?: Array<{ data?: RedditPost }> };
}

function matchKeyword(text: string): string | null {
  const lower = text.toLowerCase();
  for (const kw of KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) return kw;
  }
  return null;
}

async function fetchFeed(): Promise<RedditPost[]> {
  const res = await fetch(FEED_URL, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Reddit ${res.status}: ${res.statusText}`);
  }
  const json = (await res.json()) as RedditResponse;
  const children = json.data?.children ?? [];
  return children
    .map((c) => c.data)
    .filter((d): d is RedditPost => !!d && !!d.id);
}

export const config = {
  name: 'reddit-keywords',
  intervalMinutes: 20,
  targetGroup: 'reddit-scout',
  enabled: true,
};

export async function check(): Promise<MonitorResult> {
  initMonitorState(config.name, config.enabled);
  const state = getMonitorState(config.name)!;
  const seen = new Set(state.seen_ids);

  const posts = await fetchFeed();
  const now = Date.now();
  const maxAgeMs = MAX_AGE_HOURS * 3_600_000;

  const hits: Array<{ post: RedditPost; keyword: string; ageHours: number }> =
    [];
  for (const p of posts) {
    if (seen.has(p.id)) continue;
    const ageMs = now - p.created_utc * 1000;
    if (ageMs > maxAgeMs) continue;
    const kw = matchKeyword(`${p.title}\n${p.selftext ?? ''}`);
    if (!kw) continue;
    hits.push({ post: p, keyword: kw, ageHours: ageMs / 3_600_000 });
  }

  if (hits.length === 0) {
    return {
      shouldWake: false,
      priority: 'normal',
      data: {},
      summary: '',
    };
  }

  // Take the first (newest) hit.
  const [first] = hits;
  const allIds = [...state.seen_ids, ...hits.map((h) => h.post.id)];
  updateAfterWake(config.name, new Date().toISOString(), '', allIds);

  logger.debug(
    { hits: hits.length, first: first.post.id },
    'reddit-keywords: matches found',
  );

  return {
    shouldWake: true,
    priority: 'normal',
    data: {
      post_title: first.post.title,
      subreddit: first.post.subreddit,
      url: `https://www.reddit.com${first.post.permalink}`,
      author: first.post.author,
      age_hours: Math.round(first.ageHours * 10) / 10,
      matched_keyword: first.keyword,
      total_new_matches: hits.length,
    },
    summary: `New Reddit post in r/${first.post.subreddit} matching "${first.keyword}": ${first.post.title.slice(0, 100)}`,
  };
}

const monitor: Monitor = { config, check };
export default monitor;
