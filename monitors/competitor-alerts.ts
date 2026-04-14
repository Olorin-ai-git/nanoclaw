import { logger } from '../src/logger.js';
import { getLoadedGlobalConfig } from '../src/monitor-runner.js';
import {
  getMonitorState,
  initMonitorState,
  updateSeenIds,
} from '../src/monitor-store.js';
import type { Monitor, MonitorResult } from '../src/monitor-types.js';

interface Feed {
  source: string;
  url: string;
}

const FEEDS: Feed[] = [
  { source: 'EdSurge', url: 'https://www.edsurge.com/articles_rss' },
  { source: 'Edpuzzle', url: 'https://blog.edpuzzle.com/feed/' },
  { source: 'eLearning Industry', url: 'https://elearningindustry.com/rss' },
];

const FALLBACK_KEYWORDS = [
  'Synthesia',
  'HeyGen',
  'Colossyan',
  'D-ID',
  'interactive video',
  'AI training',
  'video learning platform',
];

const MAX_AGE_HOURS = 24;
const FETCH_TIMEOUT_MS = 25_000;

interface FeedItem {
  id: string;
  title: string;
  link: string;
  pubDate: string;
}

function parseRss(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const itemRe = /<item[\s\S]*?<\/item>/g;
  const titleRe = /<title>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/title>/;
  const linkRe = /<link>([\s\S]*?)<\/link>/;
  const guidRe = /<guid[^>]*>([\s\S]*?)<\/guid>/;
  const dateRe = /<pubDate>([\s\S]*?)<\/pubDate>/;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml))) {
    const chunk = m[0];
    const tm = titleRe.exec(chunk);
    const lm = linkRe.exec(chunk);
    const gm = guidRe.exec(chunk);
    const dm = dateRe.exec(chunk);
    const title = ((tm?.[1] ?? tm?.[2]) || '').trim();
    const link = (lm?.[1] || '').trim();
    const guid = (gm?.[1] || link || title).trim();
    const dateStr = (dm?.[1] || '').trim();
    const date = dateStr ? new Date(dateStr) : new Date();
    if (!title) continue;
    items.push({
      id: guid,
      title,
      link,
      pubDate: Number.isNaN(date.getTime())
        ? new Date().toISOString()
        : date.toISOString(),
    });
  }

  if (items.length === 0 && xml.trim().length > 100) {
    const isAtom = /<feed\b/i.test(xml) || /<entry\b/i.test(xml);
    logger.debug(
      { format: isAtom ? 'atom' : 'unknown' },
      'competitor-alerts: RSS parser returned 0 items (Atom or non-standard feed)',
    );
  }
  return items;
}

function matchKeywords(text: string, keywords: string[]): string[] {
  const lower = text.toLowerCase();
  return keywords.filter((k) => lower.includes(k.toLowerCase()));
}

async function fetchFeed(feed: Feed): Promise<FeedItem[]> {
  const res = await fetch(feed.url, {
    headers: {
      'User-Agent': 'nanoclaw-monitor/1.0',
      Accept: 'application/rss+xml',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`${feed.source} ${res.status}: ${res.statusText}`);
  }
  const text = await res.text();
  return parseRss(text);
}

export const config = {
  name: 'competitor-alerts',
  intervalMinutes: 120,
  targetGroup: 'slack_dm',
  enabled: true,
};

export async function check(): Promise<MonitorResult> {
  const keywords =
    getLoadedGlobalConfig()?.monitors[config.name]?.extras?.keywords ??
    FALLBACK_KEYWORDS;
  initMonitorState(config.name, config.enabled);
  const state = getMonitorState(config.name)!;
  const seen = new Set(state.seen_ids);

  const now = Date.now();
  const maxAgeMs = MAX_AGE_HOURS * 3_600_000;
  const hits: Array<{ feed: Feed; item: FeedItem; matched: string[] }> = [];

  for (const feed of FEEDS) {
    let items: FeedItem[];
    try {
      items = await fetchFeed(feed);
    } catch {
      // One feed down should not fail the monitor — skip and continue.
      continue;
    }
    for (const item of items) {
      const key = `${feed.source}:${item.id}`;
      if (seen.has(key)) continue;
      const published = new Date(item.pubDate).getTime();
      if (now - published > maxAgeMs) continue;
      const matched = matchKeywords(item.title, keywords);
      if (matched.length === 0) continue;
      hits.push({ feed, item, matched });
    }
  }

  if (hits.length === 0) {
    return {
      shouldWake: false,
      priority: 'normal',
      data: {},
      summary: 'No new competitor items',
    };
  }

  const first = hits[0];
  const newIds = [
    ...state.seen_ids,
    ...hits.map((h) => `${h.feed.source}:${h.item.id}`),
  ];
  updateSeenIds(config.name, newIds);

  return {
    shouldWake: true,
    priority: 'normal',
    data: {
      source: first.feed.source,
      title: first.item.title,
      url: first.item.link,
      published_date: first.item.pubDate,
      matched_terms: first.matched,
    },
    summary: `New ${first.feed.source} article mentioning ${first.matched.join(', ')}: ${first.item.title.slice(0, 100)}`,
  };
}

const monitor: Monitor = { config, check };
export default monitor;
