---
description: Start or continue Jeeves — the standing dev-assistant monitoring loop — for the repo this session is in. Watches Jira + GitHub and surfaces what needs you as suggestions you initiate (plan/review/resolve), never acting on its own; on your go-ahead it dispatches worker agents, and an approved plan's go-ahead covers its stories and one review of each story PR.
argument-hint: "[project or repo name]"
disable-model-invocation: true
---

# Jeeves — start / continue the loop

Start (or continue) **Jeeves**, the standing dev-assistant loop.

## Launch
1. Read the engine at `${CLAUDE_PLUGIN_ROOT}/BRIEF.md` once (with Read) and follow it: under the
   cockpit, load its tools first (*Running under the cockpit* — they may be deferred); load the
   constraints (*Constraints*); then **Step 0 — Resolve the project set**. `$ARGUMENTS` may name a
   project or repo (e.g. `web`) to foreground; Jeeves still watches the whole configured set.
2. **Continue, don't restart, if state already exists.** Open ledger rows (in-flight work, plans,
   waiting items) are where you resume from, not a cold start. The first paint of the session is a
   full paint (*How to report*).
3. **Enter the loop**: invoke the `loop` skill (Skill tool, `skill: "loop"`) with `args: "Jeeves
   tick — run the BRIEF tick for the loaded project set"` and **no interval**, so it self-paces.
   Its first iteration is the first tick. Invoke the skill once per session (again after a
   restart/`/clear`), never per tick. Every tick — the first one included — ends with
   `ScheduleWakeup` (BRIEF *Each tick* step 6); without it the loop stalls.

Headless, this session runs the loop on whatever model it has: set it with `/model` (BRIEF *Rules*,
model match). Under the cockpit, Settings → Jeeves sets it.
