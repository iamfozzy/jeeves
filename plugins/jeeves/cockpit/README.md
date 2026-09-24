# Jeeves Cockpit — internals

The browser cockpit for the Jeeves loop: one Node process (`server.mjs`) that serves the UI, runs
every terminal as a PTY, and hosts the MCP control plane the orchestrator drives. Each **space** is
a git worktree; each **tab** is a PTY (`claude`, `codex` or a shell) streamed to xterm.js over a
WebSocket. Using it: the plugin [README](../README.md). Settings, files and env vars:
[`SETUP.md`](../SETUP.md).

## Launch and develop

`/jeeves:cockpit`, `jeeves`, or straight from a checkout:

```bash
plugins/jeeves/bin/jeeves          # macOS/Linux
plugins\jeeves\bin\jeeves.cmd      # Windows
```

All three run `bin/cockpit.mjs`, which runs `npm ci` when `node-pty` is missing, rebuilds `dist/`
when any file under `src/` (or `index.html`, `vite.config.ts`, `package.json`) is newer than the
last build (or on `rebuild`), starts `server.mjs`, and opens the browser at
`http://localhost:<PORT>/?token=…` unless `--no-open`.

```bash
npm install
npm run dev        # web on http://localhost:4178 (Vite), backend on :4177
npm run build      # type-check + production bundle the launcher serves
```

## Server

One HTTP server on `HOST:PORT` (loopback by default):

- **`/api/*`** — token-gated JSON: repos and config, git status / changes / file diffs, PR status,
  PR list and description, branches and worktrees, worktree create/remove, file upload, open in
  editor / file manager, orchestrator context / restart / input, lifecycle hooks, Settings (config,
  cockpit, reminders, agents). Every path argument must sit inside an allowed root: a configured
  checkout, its `<path>-worktrees/` sibling, any worktree `git worktree list` reports, the data
  home, or the scratch root.
- **`/pty`** (WebSocket) — one terminal. Query: `sid` (stable `space:tab` id), `cmd`
  (`orch` · `worker` · `claude` · `codex` · `shell`), `cwd`, `scheme`.
- **`/events`** (WebSocket) — the push channel: the painted surface, dispatched workers, the
  orchestrator's context, claude-tab statuses, config-changed pings, layout saves from other
  browsers, and `open_space` / `add_tab` / `close_space` commands. A new client is primed with the current state.
- **`/mcp`** — the MCP control plane (streamable HTTP). `?role=worker&sid=…` exposes `report` and
  the child-tab tools; `?role=tab&sid=…` only the child-tab tools. `sid` names the calling session.
- Everything else serves the built UI from `dist/`.

### PTY sessions

Sessions are keyed by `sid` and live in the server, not the browser: a dropped socket detaches the
PTY and keeps it running, with 256 KB of scrollback to replay on reattach. A detached user tab is
ended after `detachMinutes` (`cockpit.json`); the orchestrator (`orch:main`) and workers
(`work:<id>`) never are. On reattach the server replays the buffer and, for claude panes, narrows
the PTY by one column and restores it, forcing claude to redraw a clean frame. The browser
reconnects a dropped socket with backoff (1 s doubling to 15 s) and resets the pane first.
Any number of panes can attach to one session (another browser tab, a phone): all of them get
the output, and input and resizes from any of them reach the PTY. The server pings every socket
and sends a `hb` frame every 15 s. A socket that misses a pong is terminated, and a pane that
hears nothing for 40 s drops its socket and reconnects, so a connection that dies silently
recovers instead of freezing on its last frame.

Every claude the cockpit launches gets per-session `--settings` (added to the user's own):
lifecycle hooks (`SessionStart`, `UserPromptSubmit`, `Notification`, `Stop`, `SessionEnd`) that run
`bin/hook.mjs`, which posts `{ id, status, sessionId }` to `/api/hook`; and a `theme` matching the
browser's colour scheme (the variant of the user's Claude Code theme — `dark-ansi` becomes
`light-ansi` in a light UI). Workers and claude tabs also get an inline `--mcp-config` for `/mcp`
with their role and `sid`, which gives them the [child-tab tools](#child-tabs). The hooks drive the status dots (working · awaiting · idle · exited)
and let the server follow the live session id across `/clear` and `/resume`, so a respawn resumes
the current conversation. A worker's `report` outcome (done / blocked / error) sticks; hooks never
overwrite it.

PTYs die with the server. After a restart, the orchestrator, workers and claude tabs respawn on
next attach with `--resume <session id>` when that transcript exists; shell and codex tabs start
fresh.

### Orchestrator

`claude --mcp-config .jeeves-mcp.json --session-id|--resume <id> --model <orchModel> --effort
<orchEffort> --permission-mode <orchPermission> --name jeeves-orchestrator /jeeves:start`, run in
the data home. `/jeeves:start` enters `/loop` self-paced through the `loop` skill; each tick
reschedules itself with `ScheduleWakeup` (BRIEF *Each tick* step 6).

The `ctx` badge reads context use from the tail of the orchestrator's transcript
(`input + cache_creation + cache_read` tokens over `JEEVES_CTX_WINDOW`), polled every 5 s.
**Restart** kills the orchestrator's process and launches a fresh one on a new session id, with
the configured model, effort and permission mode; attached panes reconnect to it, and the loop
resumes from its ledgers.

**Auto-compact** types `/compact` (with a focus on the loop's open work) when the orchestrator has
been idle for 2 minutes, no dispatched worker is still running, and context is at or above
`compactPct`. After one, it waits at least 10 minutes before another.

### Workers

`dispatch` resolves the repo, creates a worktree at `<path>-worktrees/<branch>` (reusing a local
branch, tracking an origin one, or cutting a new one from the freshly fetched base branch — the
project's **base branch**, else origin's default), copies `seedFiles` from the main checkout
(never overwriting, never escaping either tree), and spawns `claude` there with the worker MCP
config, `--model` (default `workerModel`; any Opus pinned to the configured worker Opus),
`--permission-mode <workerPermission>`, and an appended system prompt telling it to report in three
steps: write `JEEVES_REPORT.md` at the worktree root, call `report`, then message
`jeeves-orchestrator` once.

`agent` picks what the session runs as:

- **An agent file** — the user's `<data-home>/agents/<name>.md` (a custom agent, or an override of
  the built-in with that name), else the plugin's `agents/<name>.md`. The session gets
  `--agents '{"<name>": {"description", "prompt", "tools"?}}' --agent <name>`, so it runs with that
  prompt and tool list. A tool list gains `mcp__cockpit__report`, `SendMessage` and `ToolSearch` (the first two are deferred and load through it), which the
  report steps need; no list means every tool. The model goes on `--model`: a user agent's own
  model unless it is `inherit`, otherwise the rule above. Built-ins are defined inline too (not
  `--agent jeeves:<name>`), because a plugin agent's tool list would drop the report tools.
- **Anything else** (the loop's `planner` and `reviewer`) — a label for naming the branch and the
  worker; the prompt the orchestrator composes carries the role.

The worker record keeps the agent name and model, so a resume after a restart passes the same
`--model`, `--agents` and `--agent` again.

`GET /api/agents` returns `{ builtin, custom, choices }`: each built-in with its content hash and
the user's `override` if any (`stale` once the built-in's hash differs from the `base` the
override recorded), the user's other agents, and the allowed tools and models. `POST /api/agents`
takes `{ op: 'save', agent: { name, description, tools, model, prompt }, isNew? }` or
`{ op: 'delete', name }` and answers with the fresh view. Names match `^[a-z][a-z0-9-]{1,40}$` and
may not be `planner`, `reviewer` or `worker`; saving a built-in's name writes an override with
`base: <hash>`, and deleting it restores the built-in. Only `<data-home>/agents/` is written.

A report is stored on the worker's record in `.jeeves-workers.json`, so `inbox` returns it even
after a server restart; reports for a worker whose record is gone are held in memory only.

`JEEVES_REPORT.md` is listed in the repo's `.git/info/exclude`, so it is never committed and never
counts as an uncommitted change. Removing a worktree refuses when it has uncommitted changes unless forced, then runs
`git worktree remove --force` (git refuses a plain remove of any worktree with submodules) with a
five-minute timeout. An already-missing worktree counts as removed. Removing a worktree never
touches a pushed branch or PR.

## MCP tools

The orchestrator gets all of these except the child-tab tools; workers get `report` and the child-tab
tools; claude tabs get only the child-tab tools. Headless (`/jeeves:start` outside
the cockpit), none exist and the loop falls back to Task dispatch and terminal output.

| Tool | Contract |
|---|---|
| `surface_render` | Paints the dashboard. Row sections `stories` · `myPrs` · `qa` · `reviews`, plus `inFlight` and `quiet`. Applied in order: a full section replaces that section whole (`[]` clears it; an omitted one is left as is); `upsert: { <section>: [rows] }` replaces each row with the same identity or appends it; `remove: { <section>: [ids] }` deletes by identity. Identity is `<repo>#<number>` for `myPrs` / `reviews` (from `number`, else a leading `#123` in `item`) and `<repo>:<KEY>` for `stories` / `qa` (from `key`, else a leading Jira key); the repo tag matches by id, `owner/name` or bare name. `inFlight` and `quiet` are full-replace only. Returns per-section row counts plus rejected rows (no identity) and remove ids that matched nothing. Rows carry `dot` (`red` · `yellow` · `green` · `white`) and `actions` (`{ label, run }` sends `run` to the orchestrator; `type: true` types it without submitting; `{ label, href }` opens a link). Reminders aren't painted: the server watches `reminders.md` and pushes every row to the dashboard over `/events`. |
| `dispatch` | `{ agent, repo, prompt, ticket?, branch?, model? }` → `{ workId, sid, cwd, branch }`. Branch defaults to `<agent>-<ticket>`. An `agent` naming an agent file runs the session as it ([Workers](#workers)); the description lists the built-in and user agents with their descriptions, read when each MCP session starts. |
| `report` | `{ workId, status?, summary, pr?, verdict?, threads? }` — a worker's result. |
| `inbox` | Drains unacknowledged reports (`peek: true` leaves them). |
| `close_work` | `{ workId, removeWorktree?, force? }` — ends the worker's session, optionally removes its worktree, drops it from the bus. |
| `write_state` | `{ project, markdown }` writes `projects/<project>/state.md`; `{ file: 'reminders', markdown }` writes `reminders.md`. Whole file. |
| `create_project` | `{ id, repo, path?, baseBranch?, jiraKey?, reviewCommand?, seedFiles? }` — writes a minimal `project.md` and starts tracking it live. Fails if the id exists. |
| `update_project` | `{ id, reviewCommand?, seedFiles? }` — frontmatter only; an empty value or one equal to the default removes the override. |
| `delete_project` | `{ id }` — moves the project folder to `projects/.trash/`; checkouts untouched. |
| `open_space` | `{ repo, branch? \| pr? \| path?, tab?, label? }` — opens a space in the browser for the user (a branch's worktree, reused or created; a PR's head branch; an existing worktree; or the main checkout) and returns a `spaceRef`. Refuses when no browser tab is connected. |
| `add_tab` / `close_space` | `{ spaceRef, tab? }` / `{ spaceRef }` — adds a tab to, or closes, a space `open_space` opened. `close_space` never removes a worktree. |
| `open_tab` | Child tab. `{ tab: claude \| codex, prompt, title? }` → `{ tabRef, result }`. Opens a tab in the caller's worktree, started on `prompt` plus an instruction to write its result to `result`. |
| `wait_tab` | Child tab. `{ tabRef, timeoutSec? }` — blocks (default 240 s, max 600) until the child's result file appears, then returns it. `pending` on timeout; `exited` if the child ended without one. |
| `send_tab` | Child tab. `{ tabRef, text }` — deletes the previous result and types a follow-up into the child (bracketed paste, then Enter). |

The dashboard itself lives in server memory; after a server restart the orchestrator repaints it
in full.

### Child tabs

A worker or claude tab can open a sub-agent the user can watch: `open_tab` picks a `tabRef`, which is
also the new tab's id, and records the pending launch. The browser adds the tab — to the caller's
own space for a claude tab, or to a space on the worker's worktree, opened in the background and
reused by later calls, for a worker. The tab's first attach finds the pending launch by the id in
its `sid` and starts `claude <prompt>` or `codex <prompt>` in that worktree. The prompt ends by
asking for the result at `<worktree>/.jeeves-tabs/<tabRef>.md` (the folder self-ignores). `wait_tab`
polls that file every 2 s and returns it once its size holds across two polls. A tab only answers to
the session that opened it. Links live in server memory; after a restart a child is an ordinary tab.

## Auth

- **Browser token** — from `$JEEVES_TOKEN`, else `cockpit/.jeeves-token` (created on first boot,
  kept across restarts). The launch URL carries it once; the UI stores it in `localStorage`, strips
  it from the address bar, and sends it as a bearer header (or `?token=` on WebSockets). Settings →
  Jeeves → **Rotate token** writes a new one; the old stops working at once, and the rotating tab
  adopts the new one. Pinned by `$JEEVES_TOKEN` → no rotation.
- **Session token** — random per boot, never shown. Spawned sessions use it for the MCP config
  (`Authorization: Bearer`) and their lifecycle hooks, so rotating the browser token never cuts
  off the orchestrator or workers.

Both are accepted on `/api`, `/pty`, `/events` and `/mcp`; static assets are open so the page can
boot.

## Persistence

| File | Holds |
|---|---|
| `cockpit/.jeeves-token` | The browser token. |
| `cockpit/.jeeves-mcp.json` | The orchestrator's MCP config (rewritten every boot with that boot's session token). |
| `cockpit/.jeeves-orch-session` | The orchestrator's session id, following `/clear`, so a restart resumes that conversation. |
| `cockpit/.jeeves-workers.json` | Dispatched workers: workId, session id, agent, model, repo, branch, worktree, status, last report and whether it was drained. Workers whose worktree is gone are dropped on boot. |
| `cockpit/.jeeves-tabs.json` | Claude tab → session id and cwd, so tabs resume after a restart. |
| `cockpit/.jeeves-layout.json` | Open spaces and their tabs, Scratchpad tabs, pinned and recent repos. Every browser loads it from `/api/layout` and saves back to it, and a save is pushed to the other open browsers, so the Vite dev UI and the built UI show the same spaces. |
| `<data-home>/cockpit.json` | Cockpit settings (`SETUP.md`). |
| `<data-home>/…` | Config, ledgers and reminders, read and written in place. |
| browser `localStorage` | Token, active space, collapsed repos, git-panel visibility, dashboard repo filter, and a copy of the layout that paints before `/api/layout` answers. A browser's first load folds its own spaces into the server's layout. |

The `.jeeves-*` files are gitignored.

Config writes (Settings, `update_project`) edit markdown in place: bold-label fields and
frontmatter keys are rewritten on their own lines, everything else — prose, comments, order,
unknown fields — is kept byte for byte, and a missing field goes after the last field of its
section (creating the section if needed). A project write drops any value equal to the inherited
default, so `project.md` only ever holds real overrides.

## UI

- **Header** — "watching N" (hover: every configured repo with its branch, changes and ahead
  count), the `ctx` badge (teal → yellow within 15 points of the threshold → red at it; click for
  usage and Restart), the light/dark toggle, and Settings.
- **Sidebar** (`Sidebar.tsx`) — Jeeves and Scratchpad; Spaces grouped by repo (only repos with an
  open space or worker, or pinned; pinned first, then by urgency, then slug), each row showing branch,
  worktree folder, an uncommitted-changes dot and ↑/↓ against the upstream (a branch tracking its
  base rather than its own remote shows "↓n base" and "not on origin"); Agents (dispatched workers). Git
  state polls every 5 s. The bottom pill polls `/api/health`: claude session count and the memory of
  the server plus every process it spawned (macOS: physical footprint from `top`; Linux: summed RSS;
  Windows: summed working set from `Win32_Process`), cached 4 s (Windows: 15 s).
- **Quick switcher** (`Picker.tsx`) — ⌘P anywhere, Ctrl+P outside terminals; fuzzy match over
  views, spaces, workers and repos (recently opened first).
- **Orchestrator view** — the orchestrator's PTY and the dashboard (`Dashboard.tsx`): Reminders
  first, rows ordered by dot within each section, calm rows (green, white or no dot) folded per section — except approved stories (plan approved or ready to merge) and PRs, a repo filter when more
  than one repo has rows, Jira and PR links, PR rows opening their description (`gh pr view`),
  every action in the row's ⋮ menu.
- **Spaces** (`SpaceView.tsx`) — tabs (claude, codex, terminal; drag to reorder), the git panel
  (`SpacePanel.tsx`), VS Code and file-manager buttons. The panel's tabs: **Changes** (uncommitted,
  each file revertible after a confirm), **All** (the branch against `origin/<base>` — the PR's
  target, else the project's base branch) and, with a PR, **PR** (state, author, branches, size,
  every check run and the latest reviews; the description opens in a modal). A file opens a
  read-only Monaco diff. The panel polls every 5 s while visible; PR status is cached per worktree
  and branch for 30 s. Worker views are the worker's PTY plus the same panel.
- **Sections** (`Section.tsx`) — every sidebar and panel section header (bar Home) folds its body
  on click, showing a chevron while folded; the folded state persists per section.
- **Terminals** (`TerminalPane.tsx`) — xterm.js with light and dark palettes that follow the app
  theme. Claude panes have no xterm scrollback (claude owns the alternate screen), and each wheel
  event in a fullscreen claude is sent three times so a notch scrolls a useful distance. Files
  dropped on a pane upload to `<cwd>/.jeeves-uploads/` (self-gitignored, 25 MB cap) and their paths
  are typed into the session.
- **Settings** (`Settings.tsx`) — Projects, Defaults, Agents, Jeeves and Appearance tabs over
  `/api/settings/config`, `/api/agents`, `/api/settings` and `/api/reminders`.

### Appearance

The fonts live in `cockpit.json` (`uiFont`, `monoFont`, `terminalFontSize`) and reach the browser
in the `appearance` object of `/api/config`, which the app fetches at boot. A cockpit.json save
pushes a config ping on `/events`, so every open tab refetches `/api/config` and re-applies.
`applyAppearance` (`theme.ts`) is the one place they take effect:

- **Font loading** — a single `<link data-ck-fonts>` to `fonts.googleapis.com/css2` carries the UI
  font (weights 400–700), the mono font (400–600) and any family Settings is previewing, with
  `display=swap`; `system` adds nothing. A changed link replaces the old one once it has loaded.
  `index.html` only preconnects to the font hosts.
- **Mantine** — `--mantine-font-family`, `--mantine-font-family-headings` and
  `--mantine-font-family-monospace` are set inline on `:root`, over the theme's values, each
  ending in a system fallback (`system-ui, -apple-system, sans-serif` /
  `ui-monospace, Menlo, monospace`). Markdown code uses the monospace variable.
- **Terminals** — each pane reads `useAppearance()`. It opens in the fallback stack; once the chosen
  font has loaded (`document.fonts.load`), it sets xterm's `fontFamily` and `fontSize` — which is
  when xterm re-measures its cells — and refits, so cols/rows match the new cell size. A later
  change does the same live.
- **Diffs** — Monaco takes the mono font from the same store, at 13 px.
