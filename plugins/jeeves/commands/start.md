---
description: Start or continue Jeeves — the standing dev-assistant monitoring loop — for the repo this session is in. Watches Jira + GitHub and surfaces what needs you as suggestions you initiate (plan/review/resolve), never acting on its own; on your go-ahead it dispatches worker agents.
argument-hint: "[project or repo name]"
disable-model-invocation: true
---

# Jeeves — start / continue the loop

Start (or continue) **Jeeves**, the standing dev-assistant loop, for whatever repo this session
is opened in.

## Roots
- **Engine root** = `${CLAUDE_PLUGIN_ROOT}` — this plugin. The engine is `${CLAUDE_PLUGIN_ROOT}/BRIEF.md`.
- **Data home** = `$JEEVES_HOME` if set, else `~/jeeves` — personal memory: `identity.md`,
  `defaults.md`, optional `loop-constraints.md` additions, `projects/<name>/`.

If the data home has no `identity.md`, setup hasn't run. Say so once, point at `/jeeves:setup`,
then continue in generic mode with whatever's available.

## Launch
1. Read the engine at `${CLAUDE_PLUGIN_ROOT}/BRIEF.md` once (with Read) and follow it. Under the cockpit, load its
   tools first (BRIEF *Running under the cockpit* — they may be deferred). Then begin with its
   **Step 0 — Resolve the project set**: build the project index and read the open ledger rows in
   one call; a project's full `project.md` is read only when an item touches it. If the cwd sits in
   a configured repo (or `$ARGUMENTS` names one), foreground that project but still watch the rest.
   No configs → generic mode.
2. **Continue, don't restart, if state already exists.** Open ledger rows (in-flight work, plans,
   waiting items) are where you resume from, not a cold start. The first paint of the session is a
   full paint (BRIEF *How to report*).
3. Load the constraints before acting (BRIEF → *Constraints*): read the baseline
   `${CLAUDE_PLUGIN_ROOT}/loop-constraints.md`, then append any `<data-home>/loop-constraints.md`.
   They're binding, and every worker inherits them.
4. Run the first tick, then **enter the loop**: invoke the `loop` skill (Skill tool, `skill: "loop"`)
   with `args: "Jeeves tick — run the BRIEF tick for the loaded project set"` and **no interval**,
   so it self-paces. This is what makes Jeeves tick on its own — skip it and the dashboard only
   moves when the user types. Invoke it once per session (again after a restart/`/clear`), never
   per tick; from then on each tick ends with `ScheduleWakeup` per BRIEF step 6.

`$ARGUMENTS` may name a project or repo explicitly (e.g. `web`) — if given, **foreground** that
project (still watching the others). Otherwise foreground the one matching the cwd, or nothing on a
bare launch from a general standpoint. Jeeves always watches the whole configured set either way.

Reviews run the review command (default `/code-review`). Under the cockpit they run in a dispatched
`reviewer`; headless, a fresh review runs here, so this session must sit in a git repo. If it isn't,
say so once and run the rest.

**Session model:** this command runs on the session's model. Under the cockpit that's the
orchestrator model and effort in Settings → Jeeves (Sonnet at medium by default: a tick is mostly
orchestration, and the deep reasoning lives in the dispatched agents, which pick their own model).
Headless, set it with `/model`; Sonnet at medium effort is the recommendation.
