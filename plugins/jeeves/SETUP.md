# Jeeves — setup & field reference

What lives where, and every field you can set. `/jeeves:setup` follows this; the
[README](README.md) covers everyday use, [`cockpit/README.md`](cockpit/README.md) the cockpit's
internals.

## The two roots
- **Engine** (`${CLAUDE_PLUGIN_ROOT}`) — shipped with the plugin, shared, updates when the plugin
  updates: `BRIEF.md` (the loop's logic), the worker agents, the commands, the baseline
  `loop-constraints.md`, and `templates/`. Nobody edits this locally; a rule that should change for
  everyone is a PR to this repo.
- **Data home** (`$JEEVES_HOME`, else `~/jeeves`) — yours, per machine, never shared:

  | File | Holds |
  |---|---|
  | `identity.md` | Who you are ([Identity](#identitymd)). |
  | `defaults.md` | Config every project inherits, plus loop cadence and notifications ([Defaults](#defaultsmd)). |
  | `projects/<name>/project.md` | One per repo: only what differs from `defaults.md` ([Projects](#projectsnameprojectmd)). |
  | `projects/<name>/state.md` | The loop's ledger of that project's open items ([Ledger](#projectsnamestatemd)). Live; never hand-overwrite. |
  | `reminders.md` | Your reminders ([Reminders](#remindersmd)). |
  | `guard.log` | What the cockpit's guard refused the orchestrator (one JSON line each, newest last; shown in Settings → Jeeves → Guard refusals). Written by the cockpit. |
  | `agents/<name>.md` | Your agents, and your versions of built-in ones ([Agents](#agentsnamemd)). |
  | `loop-constraints.md` | Optional: your rule additions, layered on the shipped baseline ([Constraints](#constraints)). |
  | `cockpit.json` | Cockpit models, permission modes, session hygiene and fonts ([Cockpit settings](#cockpitjson)). |
  | `daily.md` | The date of the last daily summary. |

The cockpit's Settings edits identity, defaults, project overrides, agents, reminders, constraints
and `cockpit.json`. Edits to the markdown files rewrite only the lines they change and keep your
comments and prose.

## First-time setup
`/jeeves:setup` with no argument creates the data home, asks for your identity, then writes
`defaults.md` from `templates/defaults.md`, asking once for the shared facts. Don't invent Jira/Confluence ids — an unknown one stays a
`<placeholder>`, and the feature that needs it stays off until it's filled; the rest runs. It then
offers `--scan` and the `jeeves` terminal command.

## Adding projects
- **Many at once** — `/jeeves:setup --scan [dir]` finds every git checkout under your dev root (or
  `dir`) with an `origin` that isn't configured yet, guesses each one's base branch (the first of
  the defaults' **base branches** that exists on origin, else origin's default) and Jira key (the
  commonest key in recent commit subjects), shows them as a numbered list, and creates minimal
  configs for the ones you pick: `all`, `1-5,9`, `none`, with inline corrections like `3=ABC`,
  `4=nojira`, `7 base=main`. Nothing is written until you answer.
- **One** — `/jeeves:setup <name>` asks only for what the defaults and the checkout can't answer.
- **From the cockpit** — Settings → Projects → **Add repos…** opens a Scratchpad Claude tab
  running the scan. You can also ask Jeeves to add, change or drop a project; dropping one moves
  its folder to `projects/.trash/` and never touches the checkout.

A project's id is its repo name (`<owner>-<repo>` if that's taken). Setup never overwrites an
existing `project.md` or `state.md`.

## `identity.md`
Personal, never shared. Bold-label fields (`- **gh login:** \`octocat\``):

| Field | Meaning |
|---|---|
| **gh login** | Your GitHub username (`gh api user -q .login`). |
| **Jira email** | The address Jira knows you by — your assignee and QA-assignee. |
| **display name** | Names your Confluence plans folder, `Plans > <display name>`. |
| **dev root** | Where your checkouts live (e.g. `~/Dev`); a project's path defaults to `<dev root>/<repo name>`. Default `~/Dev`. |
| **confluence plans folder id** | Leave blank; the loop finds or creates your plans folder on the first plan and caches its id here. |

## `defaults.md`
Every project inherits these. Bold-label fields sit under `##` headings; `reviewCommand` and
`seedFiles` are frontmatter keys. A `<placeholder>` value counts as unset.

| Section | Field | Meaning | Unset → |
|---|---|---|---|
| Jira | **cloudId** | Atlassian cloudId, with the site name in parentheses — `` `1a2b3c4d-…` (acme) `` — which links ticket keys to `<site>.atlassian.net`. | Jira off |
| Jira | **plan trigger** | The status that surfaces `plan <TICKET>`. | `In Progress` |
| Jira | **QA-assignee field** | Single-user custom field distinct from `assignee`, e.g. `customfield_12345`. | QA off |
| Jira | **QA columns** | Statuses that count as "in QA", comma-separated. | QA off |
| Confluence | **space** | Where plan pages publish. | plans off |
| Confluence | **Plans parent** | Folder your plans nest under: `<Plans parent> > <display name>`. | — |
| GitHub | **review scope** | `mine` = PRs requesting or reviewed by you; `repo` = also every open non-draft teammate PR. Set `repo` per project, not here. | `mine` |
| GitHub | **base branches** | Branch-name conventions `--scan` tries, in order. | origin's default |
| frontmatter | `reviewCommand` | What a review runs — `review <pr>` and a story PR's own. | `/code-review` |
| frontmatter | `seedFiles` | Gitignored files copied from the main checkout into every new worktree, comma-separated (a file missing from a checkout is skipped). | none |
| Loop | **tick seconds** | Wait between ticks (30–86400). | `300` |
| Loop | **tick mid-flight seconds** | Wait while a worker is running. | `120` |
| Loop | **tick overnight seconds** | Wait inside the overnight window. | `1800` |
| Loop | **overnight** | `HH:MM-HH:MM`, local time. | `22:00-08:00` |
| Loop | **daily summary** | `on` / `off` — the first tick after **daily summary at** each day paints done-since-yesterday, in flight, and waiting on you. | `on` |
| Loop | **daily summary at** | `HH:MM`. | `09:00` |
| Loop | **voice** | How Jeeves talks, e.g. `British, dry`. Brevity and no filler apply whatever it is. | plain, direct |
| Notifications | **push notifications** | `on` / `off` — master switch for Claude Code push notifications. | `on` |
| Notifications | **notify reminders** | Push when a reminder falls due. | `on` |
| Notifications | **notify worker finished** | Push when a dispatched worker's report lands. | `on` |
| Notifications | **notify review ready** | Push when a reviewer's compiled report lands. | `on` |

The loop reads `defaults.md` at launch, so a change applies on the orchestrator's next Restart —
except, under the cockpit, the tick and overnight fields: `now()` reads them on every call, so they
apply at the next tick.
Settings adds a missing field under its section heading. Any tick shortens its wait so it fires by
the next reminder's due time.

## `projects/<name>/project.md`
**Config = defaults + project.** A field the project sets (same bold label, or same frontmatter
key) replaces the default; anything it omits is inherited. With no `defaults.md`, a full
standalone `project.md` works on its own. A minimal one (`templates/project.template.md`):

```markdown
# Project: web

## Identity
- **repo:** `acme/web`
- **base branch:** `qa`

## Jira
- **project key:** `ABC`

## GitHub
- **review scope:** `repo`
```

| Field | Meaning | Unset → |
|---|---|---|
| **repo** | GitHub slug `owner/name`. Required. | — |
| **base branch** | Merge target, diff base, and what new branches are cut from. | origin's default branch |
| **path** | Local checkout. | `<dev root>/<repo name>` |
| **project key** | Jira key, e.g. `ABC` — maps tickets to this repo and links `ABC-1234`. | no Jira |
| any `defaults.md` field | Overrides it for this repo — e.g. `review scope: repo`, its own **QA columns**, `seedFiles`. | inherited |
| `attribution:` | When several repos share one Jira key: the component, label, JQL fragment or title prefix (`title Web`) that marks this repo's tickets. Without one, Jeeves guesses from a ticket's title when it names only this repo, else asks you (`plan <TICKET> in <repo>`). | guess from title, else ask |

Prose in `project.md` — a review policy, protected paths, worktree notes — is instruction to the
loop for that repo and wins over the loop's defaults. Settings → Projects edits the common fields, shows
each as *set here* or *default*, and never writes a value equal to the default; other overrides are
listed there for you to edit in the file.

**Scale.** A tick queries GitHub and Jira by you, not by repo, and keeps only results from
configured repos, so its cost doesn't grow with the project count. The exception is
`review scope: repo`: each such repo adds all its open teammate PRs to every tick, so keep it to
the repos you actually review. A project's full `project.md` is read only when one of its items
needs acting on.

## `projects/<name>/state.md`
The loop's ledger: one line per **open** item, nothing else. Statuses, checks and calm tickets come
fresh from each tick's queries and are never written; a ledger is written only when one of its rows
changes. Resolved items are deleted (worth-mentioning ones become `done` rows, kept 24 hours for the
daily summary).

```
# state · web
<!-- Open items only, one row each: … -->
- ticket ABC-5830 · awaiting-approval · waiting on your approval · since 2026-09-21 · page=123 · comment=456
- story ABC-5830/S2 · queued · after S1 merges · since 2026-09-22 · deps=S1
- review #1860 · reviewed · re-check on new commits · since 2026-09-20 · sha=ab12cd3
```

Row shape: `- <kind> <id> · <state> · <next> · since <YYYY-MM-DD>[ · key=value …]`. Kinds:
`ticket`, `story`, `work`, `pr`, `review`, `ask`, `done` — states and keys per kind are in
[`BRIEF.md`](BRIEF.md) *State ledger*. `next` is one clause: what happens next, or a standing
decision of yours. Settings → Projects shows a project's open items. A legacy prose `state.md` is
converted to a ledger on the loop's next launch.

## `reminders.md`
```
# reminders
<!-- One row each: - <id> · due <YYYY-MM-DD HH:MM> · <what> · set <YYYY-MM-DD>. Delete on done. -->
- r3 · due 2026-09-23 15:00 · ask Brendan about the RC connector · set 2026-09-23
```

Ids are `r<n>`; times are local. Add them by telling Jeeves (`remind …`) or in Settings → Jeeves →
Reminders (which also marks done, snoozes by 1 h / 1 day, and deletes). The loop re-reads the file
every tick. The dashboard lists every row, soonest first; an overdue one turns red and stays until
you act on it.

## `agents/<name>.md`
Your own agents, which Jeeves runs when you ask (`run <agent> on <ticket | #pr | repo>`) and may
suggest when an item matches one's description. Same format as the plugin's `agents/*.md` — Claude
Code agent markdown:

```markdown
---
name: security-audit
description: Audits a PR's diff for injection, auth and secrets mistakes
tools: Read, Grep, Glob, Bash
model: claude-sonnet-5
---

You audit one PR for security mistakes…
```

| Field | Meaning | Unset → |
|---|---|---|
| `name` | The file name without `.md`: lowercase letters, digits and `-`, starting with a letter (2–41 characters). `worker` is taken by the loop; a built-in's name customises that built-in. | required |
| `description` | One line: when to use it. The loop matches items against it. | required |
| `tools` | Comma list from `Bash`, `Read`, `Edit`, `Write`, `Grep`, `Glob`, `Skill`, `Workflow`, `WebFetch`, `WebSearch`, `NotebookEdit`, `Task`. | every tool |
| `model` | `inherit`, `claude-opus-5-5`, `claude-sonnet-5`, `claude-haiku-4-5`, `claude-fable-5-1` or `claude-opus-5`. | `inherit` — the worker model from `cockpit.json` |
| `base` | Written by Settings on an override: the hash of the built-in it was customised from. | — |
| body | The agent's system prompt. | required |

A file named like a built-in (`planner`, `story-worker`, `reviewer`, `review-resolver`,
`investigator`, `loop-verifier`) **overrides** it:
cockpit dispatches of that agent run your version; headless (Task) dispatches still use the
plugin's. Settings → Agents flags an override whose built-in has changed since (its hash no longer
matches `base`) and shows the current built-in beside yours; saving your version again clears the
flag, **Reset to built-in** deletes it. Plugin updates never touch this folder. Agents run only
under the cockpit.

## Constraints
The binding safety rules. The baseline ships in the plugin (`loop-constraints.md`) and updates with
it — never copy it. Your additions go in `<data-home>/loop-constraints.md`
(`templates/loop-constraints.additions.md` is a starting stub): appended on top, and on a direct
conflict yours wins. No file → the baseline alone. Edit them in Settings → Jeeves → Constraints,
which also shows the baseline read-only. The loop loads both at launch.

## `cockpit.json`
Settings for the sessions the cockpit spawns, and the UI's fonts. Settings → Jeeves and
Settings → Appearance write it; each key with an env var can be pinned by it instead, which wins and
shows read-only in Settings. A pinned number or font that isn't valid is ignored with a warning at
boot.

| Key | Env var | Default | Meaning |
|---|---|---|---|
| `orchModel` | `JEEVES_ORCH_MODEL` | `claude-sonnet-5` | The orchestrator's model. |
| `orchEffort` | `JEEVES_ORCH_EFFORT` | `medium` | Its reasoning effort: `low` · `medium` · `high` · `xhigh` · `max`. |
| `workerModel` | `JEEVES_WORKER_MODEL` | `claude-opus-5-5` | Dispatched workers' model. Any Opus the loop asks for runs as this if it's an Opus, else as `claude-opus-5-5`. |
| `orchPermission` | `JEEVES_ORCH_PERMISSION` | `auto` | The orchestrator's `--permission-mode`: `auto` · `manual` · `acceptEdits` · `plan` · `dontAsk` · `bypassPermissions`. |
| `workerPermission` | `JEEVES_WORKER_PERMISSION` | `auto` | Workers' permission mode. Keep it equal to the orchestrator's — worker messages reach the orchestrator unprompted only between sessions in the same mode. |
| `rotatePct` | `JEEVES_ORCH_ROTATE_PCT` | `70` | Context share (1–100 %) at which the `ctx` badge turns red and Restart lights. |
| `compactPct` | `JEEVES_ORCH_COMPACT_PCT` | `40` | Context share (0–100 %) at which an idle orchestrator, with no worker running, runs `/compact`. `0` = never. |
| `atlassianServer` | `JEEVES_ATLASSIAN_SERVER` | `claude_ai_Atlassian_Rovo` | The MCP server the loop uses for Jira and Confluence, as its tool names spell it (`mcp__<name>__getJiraIssue`): letters, digits, `_` and `-`. Set it when Atlassian is connected under another name (`claude mcp add`). Applies on the orchestrator's next Restart. |
| `claudeTui` | — | `fullscreen` | Claude Code's renderer in every session the cockpit launches: `fullscreen` · `default`. |
| `scrollSpeed` | — | `3` | Lines per mouse-wheel step in fullscreen (1–20). |
| `detachMinutes` | — | `30` | Minutes a tab with no browser attached lives before it's ended (0–10080; `0` = never). The orchestrator and workers are never ended. |
| `uiFont` | `JEEVES_UI_FONT` | `Roboto` | The UI font: a Google Fonts family name (letters, digits, spaces and `-`, up to 60), or `system` for the OS font. |
| `monoFont` | `JEEVES_MONO_FONT` | `Roboto Mono` | The font for terminals, diffs and code, same format. |
| `terminalFontSize` | `JEEVES_TERMINAL_FONT_SIZE` | `13` | Terminal font size in px (10–20). |

Model and permission changes apply to sessions spawned afterwards; the orchestrator picks them up
on its next Restart. Hygiene and font
settings apply at once; a font save reaches every open cockpit tab.

## Environment variables
| Variable | Default | Effect |
|---|---|---|
| `JEEVES_HOME` | `~/jeeves` | The data home. |
| `PORT` | `4177` | Cockpit port. |
| `HOST` | `127.0.0.1` | Bind address. |
| `SHELL` | `bash` (Windows: `powershell.exe`) | Shell for terminal tabs. |
| `JEEVES_TOKEN` | persisted random token | Pins the browser access token (disables Rotate token). |
| `JEEVES_SCRATCH_ROOT` | home directory | Where the Scratchpad's terminals start. |
| `JEEVES_JIRA_BASE` | from **cloudId**'s site | Base URL for ticket links, e.g. `https://acme.atlassian.net/browse`. |
| `JEEVES_CTX_WINDOW` | `1000000` | The orchestrator's context window, for the `ctx` badge. |
| `JEEVES_COCKPIT_NO_OPEN` | — | `1` = don't open the browser on launch (same as `--no-open`). |
| `JEEVES_ORCH_NAME` | `jeeves-orchestrator` | The orchestrator's session name, which workers message. |
| `JEEVES_ORCH_SESSION_ID` | random per boot | The orchestrator's starting session id. |
| `JEEVES_*` model / permission / rotate / font vars | — | Pin a [`cockpit.json`](#cockpitjson) key. |

## Confluence plan folders
Plans publish to `<Plans parent> > <display name>` in the configured space, never the space root.
On your first plan the loop finds that folder or creates it, then caches its id in `identity.md`.
Each teammate gets their own folder automatically. One page per ticket, revised in place.

## Dependencies
- **`gh`** authenticated — GitHub queries and PR writes.
- **Atlassian MCP** — Jira queries and Confluence plan pages: the claude.ai Atlassian Rovo
  connector, or another server named in `cockpit.json` `atlassianServer`.
- **A git-repo cwd for reviews** — the review command (default `/code-review`) runs in the repo
  checkout. Under the cockpit, reviewer sessions do; headless, the main loop must be in a git repo.
