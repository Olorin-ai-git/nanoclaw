# Migration State

## Progress

- [x] Phase 0: Discovery
- [x] Phase 1: Groups and Architecture
- [x] Phase 2: Settings from Config
- [x] Phase 3: Identity and Memory
- [x] Phase 4: Channel Credentials
- [x] Phase 5: Scheduled Tasks
- [x] Phase 6: Webhooks, MCP, and Other Config
- [x] Phase 7: Summary

## Decisions

- assistant_name: Olorin
- group_model: fully separate
- main_group: whatsapp_shagaat (972544478046-1550137364@g.us)

## Registered Groups

| folder               | jid                                        | channel  | is_main |
| -------------------- | ------------------------------------------ | -------- | ------- |
| whatsapp_shagaat     | 972544478046-1550137364@g.us               | whatsapp | yes     |
| whatsapp_hamishpacha | 972543058894-1534998966@g.us               | whatsapp | no      |
| slack_dm             | slack:u09gdjdaeem                          | slack    | no      |
| slack_thread-1       | slack:d0aqn2fem8t:thread:1775266136.801509 | slack    | no      |
| slack_thread-2       | slack:d0aqn2fem8t:thread:1775570569.264459 | slack    | no      |
| slack_channel-1      | slack:c0arq7mh8uq                          | slack    | no      |
| slack_channel-2      | slack:c0aqvuwjuen                          | slack    | no      |

## Settings Migrated

- timezone: America/New_York
- anthropic_credential: sk-a...9QAA
- openai_credential: sk-p...l8A
- resend_api_key: re_N...6M
- sender_allowlist: created at ~/.config/nanoclaw/sender-allowlist.json

## Identity & Memory

- whatsapp_shagaat: identity.md, soul.md, user-context.md, memories.md, daily-memories/ (4 files)
- whatsapp_hamishpacha: identity.md, soul.md, user-context.md, memories.md (copied from shagaat)
- slack_dm + 4 slack groups: identity.md, soul.md, user-context.md (Radagast personality)
- All CLAUDE.md files updated with personality references

## Channel Credentials

| channel         | status                     | env_var                          |
| --------------- | -------------------------- | -------------------------------- |
| whatsapp        | needs QR auth during setup | -                                |
| telegram        | saved                      | TELEGRAM_BOT_TOKEN               |
| slack (default) | saved                      | SLACK_BOT_TOKEN, SLACK_APP_TOKEN |

## Scheduled Tasks

| original_name            | id                         | status |
| ------------------------ | -------------------------- | ------ |
| olorin-marketing-team    | migrated-marketing-team    | active |
| Meeting Scanner          | migrated-meeting-scanner   | active |
| Weekly Initiative Review | migrated-initiative-review | active |
| olorin-weekly-report     | migrated-weekly-report     | active |
| training-portal-qa       | migrated-training-qa       | active |
| olorin-outreach          | migrated-outreach          | active |
| olorin-competitor-intel  | migrated-competitor-intel  | paused |
| olorin-blog-draft        | migrated-blog-draft        | paused |
| olorin-social-content    | migrated-social-content    | paused |
| olorin-atomize           | migrated-atomize           | paused |
| olorin-publish           | migrated-publish           | paused |
| olorin-engage            | migrated-engage            | paused |
| olorin-metrics           | migrated-metrics           | paused |

## Deferred / Not Applicable

- olorin-log-rotate: OpenClaw team-log rotation, not applicable
- olorin-coordinator: OpenClaw cycle.sh, not applicable
- medium-sync-character-memory: expired one-time task
- linkedin-character-memory-detailed: expired one-time task
- Saruman Slack account: separate bot tokens not migrated
- OpenClaw-specific: exec approvals, voice/talk, gateway, webhook delivery, failure alerts
- Skills not migrated: capability-evolver, memory-core (LanceDB), Web-Search (built-in), olorin-outreach skill (OpenClaw messaging), find-skills (meta)
- Container rebuild needed: 4 skills copied (exa, gog, initiative-tracker, n8n)
