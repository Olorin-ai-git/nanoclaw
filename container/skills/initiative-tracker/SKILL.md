---
name: initiative-tracker
description: Track Gil's work initiatives and launch plans. Use when Gil mentions a project he wants to launch, a goal he's working toward, or asks to track tasks, progress, or weekly reviews for an initiative. Triggers on phrases like "track this initiative", "add to my launch plan", "what do I need to do this week", "weekly review", "what did I accomplish", or when Gil describes a new project and asks for a plan.
---

# Initiative Tracker

Manage Gil's work initiatives: maintain a to-do list, break plans into daily tasks, and deliver weekly reviews.

## Data File

All initiative data lives at: `~/.openclaw/workspace/initiatives/`

- One file per initiative: `<initiative-slug>.md`
- Weekly review log: `weekly-reviews.md`

Create the `initiatives/` directory if it doesn't exist.

## Initiative File Structure

```markdown
# <Initiative Name>

**Status:** Active | Paused | Launched
**Goal:** <one-line description>
**Launch Target:** <date or "TBD">

## To-Do List
- [ ] Task 1
- [ ] Task 2
- [x] Completed task

## Daily Tasks
### Week of <Mon DD>
- **Monday:** Task A, Task B
- **Tuesday:** Task C
...

## Notes
<freeform context, decisions, blockers>
```

## Workflows

### Adding a New Initiative

1. Ask Gil: name, goal, launch target date (if known)
2. Ask: "What are the key things that need to happen for a successful launch?"
3. Create `initiatives/<slug>.md` with the structure above
4. Break the to-do list into a **daily task plan** for the current week
5. Confirm the plan with Gil

### Adding Tasks

When Gil says "I need to do X for <initiative>":
1. Add to the initiative's To-Do List
2. Schedule into the daily plan (next available slot or ask Gil when)
3. Confirm: "Added: X — scheduled for <day>"

### Daily Task Breakdown Rules

- Max **2-3 meaningful tasks per day** (realistic, not overwhelming)
- Prioritize: launch-blocking tasks first, polish last
- If no launch date, spread evenly over 2 weeks
- Leave buffer days (Friday = catch-up, not new tasks)

### Weekly Review (every Friday or when Gil asks)

1. Read the current week's daily tasks
2. Check off completed items (ask Gil which ones are done if unclear)
3. Send Gil a summary:
   ```
   🎉 This week on <Initiative>:
   ✅ Done: [list]
   ⚠️ Missed: [list]
   📅 Next week: [top 3 priorities]
   ```
4. Roll unfinished tasks into next week's plan
5. Append to `weekly-reviews.md`

### Status Check

When Gil asks "where are we on X?":
1. Read `initiatives/<slug>.md`
2. Report: % complete, what's left, next task, any blockers

## Multiple Initiatives

List all active initiatives when Gil asks "what am I working on?" — read all files in `initiatives/` and summarize status.

## Weekly Cron

Remind Gil to do a weekly review every Friday at 5 PM ET:
- Check `initiatives/` for active initiatives
- Send a WhatsApp message: "Hey Gil — end of week! Want me to run your initiative review? 📋"
