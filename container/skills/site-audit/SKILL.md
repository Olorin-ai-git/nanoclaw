---
name: site-audit
description: Use when auditing olorin.ai sites — health checks, page verification, visitor stats, and E2E user flows. Triggered by scheduled tasks, /site-audit command, or when asked to check site health.
allowed-tools: Bash(agent-browser:*)
---

# Site Audit — Olorin Web Properties

Verify integrity, run E2E flows, pull analytics, and compile a briefing for Gil.

## Sites

| Site       | URL                            | Purpose                                       |
| ---------- | ------------------------------ | --------------------------------------------- |
| Main       | `https://olorin.ai`            | Marketing, product pages, blog, B2B dashboard |
| Training   | `https://training.olorin.ai`   | B2B L&D platform, admin portal                |
| Playground | `https://playground.olorin.ai` | Interactive product demo, tour stops          |

All three are React apps on Firebase Hosting.

## Audit Workflow

Run all three phases, then compile the briefing.

### Phase 1: Health Check (all sites)

For each site, verify pages load and key elements render.

```bash
agent-browser open <url>
agent-browser wait --load networkidle
agent-browser get title
agent-browser snapshot -c
agent-browser screenshot /workspace/group/audit/<site>-home.png
```

**Check for:**

- Page title is not empty or "Error"
- No blank page (snapshot has real content)
- Console errors: `agent-browser eval "window.__consoleErrors || []"`

**Pages to check per site:**

_olorin.ai:_

- `/` (home — look for hero section, feature cards)
- `/features`
- `/pricing`
- `/blog` (verify at least one post renders)
- `/contact`
- `/api-docs`

_training.olorin.ai:_

- `/` (landing — pricing CTA visible)
- `/pricing`
- `/login` (form renders)

_playground.olorin.ai:_

- `/` (landing)
- `/tour` (tour welcome — verify stop count renders)
- `/hub` (capability cards visible)
- `/login` (form renders)

Record pass/fail for each page. A page fails if: blank content, error title, HTTP error, or key element missing.

### Phase 2: E2E User Flows

Run these critical flows using `agent-browser`:

**Flow 1 — Playground Tour (unauthenticated):**

1. `open https://playground.olorin.ai/tour`
2. Verify tour welcome loads with stop list
3. Click first public stop
4. Verify stop content renders (video or interactive element)
5. Navigate back to tour, verify progress state

**Flow 2 — Main Site Navigation:**

1. `open https://olorin.ai`
2. Click "Features" in nav
3. Verify features page content
4. Click "Pricing" in nav
5. Verify pricing tiers render
6. Click blog link, verify post list

**Flow 3 — Training Landing → Login:**

1. `open https://training.olorin.ai`
2. Click CTA / "Get Started" or "Login"
3. Verify login form renders with email + password fields
4. Do NOT submit credentials

Screenshot each flow step to `/workspace/group/audit/`.

### Phase 3: Visitor Statistics

Pull analytics from GA4 (Measurement ID: `G-XJN6H11XNP`, playground only).

**Option A — Google Analytics dashboard (if authenticated):**

```bash
agent-browser open https://analytics.google.com
# Navigate to GA4 property for playground.olorin.ai
# Pull: active users (7d), page views (7d), top pages, traffic sources
```

**Option B — If not authenticated or blocked:**
Report that GA4 access requires manual login. Suggest Gil grant access or provide a GA4 API key for automated pulls.

**Fallback check — verify GA tag fires:**

```bash
agent-browser open https://playground.olorin.ai
agent-browser eval "typeof gtag === 'function' ? 'GA4 active' : 'GA4 missing'"
```

Do the same for olorin.ai and training.olorin.ai to confirm analytics tags are present.

## Briefing Format

Compile results into a Slack message using mrkdwn:

```
*Site Audit Report — {date}*

*Health Check:*
• olorin.ai: {N}/{total} pages OK {any failures listed}
• training.olorin.ai: {N}/{total} pages OK
• playground.olorin.ai: {N}/{total} pages OK

*E2E Flows:*
• Playground Tour: {PASS/FAIL} — {detail if failed}
• Main Navigation: {PASS/FAIL}
• Training Login: {PASS/FAIL}

*Analytics:*
• GA4 tags: {present/missing per site}
• Playground 7d: {users} users, {pageviews} views (if available)
• Top traffic: {source breakdown} (if available)

*Issues Found:*
• {list any failures, broken pages, missing elements}
• {or "None — all checks passed"}
```

Send via `mcp__nanoclaw__send_message` to Gil's Slack DM.

If all checks pass, keep the message short. Only expand on failures.

## Scheduling

This audit is designed to run as a scheduled task. Example schedule:

```
Run /site-audit and send me the results.
```

Recommended frequency: weekly or after deployments.

## Troubleshooting

- **agent-browser not available:** Fall back to `curl -sL -o /dev/null -w "%{http_code}" <url>` for basic HTTP checks. Report that full E2E requires browser.
- **Page loads but blank:** React app may have JS error. Check `agent-browser eval "document.getElementById('root')?.innerHTML?.length || 0"` — if 0 or very small, the app failed to hydrate.
- **GA4 dashboard login required:** Skip analytics section, note in report. Suggest API-based approach for future automation.
- **Timeout on page load:** Retry once. If still failing, record as failure with "timeout" reason.
