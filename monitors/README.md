# Monitors

Monitors are lightweight pollers that watch external sources and wake agents when they find something actionable. They run inside the main NanoClaw process — no separate daemon, no LLM calls.

## Adding a new monitor

1. Create `monitors/<name>.ts` that exports:

   ```ts
   import type { Monitor, MonitorResult } from '../src/monitor-types.js';

   export const config = {
     name: '<name>',
     intervalMinutes: 30,
     targetGroup: '<group-folder>',
     enabled: true,
     // optional:
     // weekdaysOnly: true,
     // businessHours: { start: '08:00', end: '18:00' },
     // respectQuietHours: true,
   };

   export async function check(): Promise<MonitorResult> {
     // fetch + parse + condition check — no LLM calls
     return { shouldWake: false, priority: 'normal', data: {}, summary: '' };
   }

   const monitor: Monitor = { config, check };
   export default monitor;
   ```

2. Add it to `monitors/index.ts` (the runner uses a static registry).

3. Add a per-monitor entry in `monitors/config.json` to override defaults (optional).

4. Test with `scripts/claw --monitor <name> --run-now`.

## Keep monitors small

Each monitor should be 30–80 lines. Use `initMonitorState`/`getMonitorState`/`updateAfterWake` for per-monitor state (seen IDs, last hash). Do not store monitor state in files.

## Priority semantics

- `low` — intel, no wake on opens/clicks-only flows
- `normal` — interesting, wake the target agent
- `urgent` — wake the agent AND notify the main group; bypasses quiet hours

## Deduplication

The runner skips a wake when the SHA-256 of `result.data` matches the previous wake. For per-item dedup (e.g., Reddit post IDs), store seen IDs via `updateAfterWake` and filter yourself in `check()`.

## RSS monitors to add later

Synthesia, HeyGen, Colossyan, and D-ID blogs don't expose RSS. Add scraping-based monitors (Cheerio/Playwright) when needed.

## CLI

```bash
scripts/claw --monitors                   # list all monitors with state
scripts/claw --monitor <name> --enable
scripts/claw --monitor <name> --disable
scripts/claw --monitor <name> --run-now   # fire once against live APIs
scripts/claw --monitor <name> --history   # show last 10 runs
```
