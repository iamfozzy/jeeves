# Jeeves

A standing dev-assistant loop. Jeeves watches your Jira + GitHub across every project you configure
and surfaces what needs you — stories to plan, your PRs, QA on you, teammates' PRs to review, your
reminders — as suggestions you initiate (`plan` / `review` / `resolve` / `qa`), never acting on its
own. On your go-ahead it dispatches worker agents in isolated git worktrees. It ships with a local
browser **cockpit**: a live dashboard on the right, real terminal spaces on the left.

Everything runs on your machine. The cockpit is loopback-only and token-gated; each teammate runs
their own, nothing is shared over the network.

- **First run?** → [Getting started](#getting-started).
- **Field reference** (`defaults.md`, `project.md`, `identity.md`, `cockpit.json`, env vars,
  `reminders.md`, `state.md`, `agents/`): [`SETUP.md`](SETUP.md).
- **Cockpit internals** (server, MCP tools, auth, persistence): [`cockpit/README.md`](cockpit/README.md).

## Requirements

- **Claude Code** with this `jeeves` plugin installed: `/plugin marketplace add iamfozzy/jeeves`,
  then `/plugin install jeeves@jeeves`. Reviews use the built-in `/code-review`.
- **Node.js ≥ 20** (the cockpit server + UI build).
- **`gh`** installed and authenticated (`gh auth login`) — GitHub queries and PR writes.
- **Atlassian Rovo MCP** connected in Claude Code — Jira queries and Confluence plan pages.
- A C/C++ toolchain for the cockpit's native `node-pty`:
  - **macOS**: `xcode-select --install`
  - **Windows**: the "Desktop development with C++" workload (Visual Studio Build Tools) — usually
    already present; `npm` builds `node-pty` on first cockpit launch.
  - **Linux**: `build-essential` (gcc/make/python3).

## Getting started

Everything below runs **inside a Claude Code session** with the plugin installed — no PATH setup
needed. (For a plain terminal command, see [Shortcuts](#shortcuts--the-jeeves-terminal-command).)

1. **Set yourself up** — run once:

   ```
   /jeeves:setup
   ```

   It creates your **data home** (`~/jeeves`, or `$JEEVES_HOME`), asks for your identity (GitHub
   login, Jira email, display name, and the dev root where your checkouts live, e.g. `~/Dev`), and
   writes the shared defaults every project inherits (Jira, QA fields, Confluence, base branches).
   Nothing here is shared.

2. **Add projects** — every repo you want Jeeves to watch:

   ```
   /jeeves:setup --scan          # pick from every unconfigured checkout under your dev root
   /jeeves:setup owner/my-repo   # or one repo at a time
   ```

   `--scan` lists every git checkout not yet configured, with a guessed base branch and Jira key,
   and creates a minimal config for each one you pick (`all`, `1-5,9`, corrections like `3=ABC`).
   A project's config holds only what differs from the defaults.

3. **Open the cockpit** — `/jeeves:cockpit` in Claude Code, or the **`jeeves`** terminal command
   (setup offers to install it):

   ```
   /jeeves:cockpit      # in a Claude Code session
   jeeves               # from any terminal (once installed)
   ```

   First launch installs dependencies and builds the UI (~1 minute); later launches are instant. It
   prints a `http://localhost:4177/?token=…` URL and opens it in your browser. The cockpit boots the
   loop's orchestrator (left pane) and the dashboard it paints (right).

> **Headless** (no browser): run `/jeeves:start` in a Claude Code session — the same loop,
> terminal-only, with the dashboard printed as tables. Launched inside a configured checkout, that
> project is reported first; Jeeves still watches every configured project.

## Everyday use

Jeeves ticks on its own (every 5 minutes by default, faster while a worker runs, slower overnight)
and repaints only what changed. However many projects you configure, a tick costs one GitHub query
and one Jira query. Leave it running — the orchestrator and dispatched workers carry on with the
browser closed.

### The dashboard

The right pane of the **Jeeves** view. Sections, top to bottom:

- **Reminders** — every reminder you've set, soonest first: red once overdue, yellow within 24
  hours. Done and snooze from the row's ⋮ menu. Never filtered or folded.
- **Stories** — every sprint ticket assigned to you, with its Jira status and, for tickets in the
  plan flow, its phase (needs plan → planning → awaiting approval → approved → in progress → in
  review).
- **Items for you to QA** — every sprint ticket whose QA field is you, whatever its status,
  highest priority first: yellow once it reaches a QA column (with a Test action), grey while
  it's still upstream, green once done.
- **My PRs** — your open PRs with checks and review state.
- **Reviews** — teammates' PRs in your review scope.
- **In flight** — workers running now.

In Stories and QA, every open ticket (To Do included) shows in full and only done tickets fold
into one "N done — show" line. In the PR sections, red and yellow rows show in full and calm rows
fold into one "N on track — show" line.
With more than one repo on the board, a searchable repo filter sits at the top (remembered per
browser). Jira keys and `#123` link out; clicking a PR row opens its description. Each row's **⋮**
menu holds its actions (Plan, Approve, Resolve, Review, Test, View plan, Open PR on GitHub…) — each
sends the matching command to the loop.

### Talking to Jeeves

Type into the orchestrator (the left pane of the Jeeves view), or fire the same commands from a
row's ⋮ menu. Nothing runs until you ask.

| Command | Does |
|---|---|
| `plan <TICKET>` | Plans a ticket you moved to In Progress: publishes a Confluence plan page with a story breakdown, links it from the ticket. Shared Jira key → `plan <TICKET> in <repo>`. |
| `approve <TICKET>` / `approve <TICKET> S1, S3` | Approves the plan (or only those stories) — Jeeves dispatches one worker per story, in parallel where dependencies allow. |
| `change <TICKET>: …` | Revises the plan. Comments on the ticket work too. |
| `review <pr>` | Runs a review of a teammate's PR (your review command, default `/code-review`). |
| `comment <pr>` / `approve <pr>` / `request-changes <pr>` | Posts the finished review with that verdict. Nothing posts until you pick one. |
| `resolve <pr>` | Addresses the change requests on your own PR, pushes, and resolves the threads it fixed. |
| `qa <KEY>` | Prints the ticket's testing instructions and opens it in the browser. Read-only. |
| `run <agent> on <ticket \| #pr \| repo>` | Dispatches one of your agents (Settings → Agents) on that target, as a worker in its own worktree. Cockpit only. Jeeves may suggest one when an item matches the agent's description. |
| `remind 15:00 …` / `remind in 2h …` / `remind tomorrow 9am …` | Sets a reminder; it surfaces (and pushes a notification) when due. |
| `done <id>` / `snooze <id> 1h` | Clears or moves a reminder. |

Jeeves never merges, never posts a review until you pick its verdict, and never touches `.env`,
`auth/`, `payments/`, `secrets/` or `credentials/` — the shipped baseline rules
([`loop-constraints.md`](loop-constraints.md)), plus any of your own (Settings → Jeeves).

### Spaces and terminals

- **Sidebar** — **Jeeves** (the orchestrator and dashboard), **Scratchpad** (terminals rooted at
  your home directory), then **Spaces** grouped by repo and **Agents** (dispatched workers). A repo appears
  only while it has an open space or worker, or you've pinned it; pinned repos come first, then
  the ones needing attention. Each space row shows its branch and worktree folder, an amber dot
  for uncommitted changes, and ↑/↓ commit counts against its upstream.
- **Open a space** — the repo row's **+**, or **+** on the Spaces header to pick a repo. Choose an
  existing or new branch, an open PR, or an existing worktree. A new branch is cut from the
  project's freshly fetched base branch, and the project's seed files (e.g. `.env`) are copied in.
- **⌘P / Ctrl+P** — quick switcher: jump to any space, worker or repo. (Ctrl+P works outside
  terminals only, so it stays previous-command inside them.)
- **Tabs** — each space holds `claude`, `codex` and shell tabs. Double-click to rename, middle-click
  to close. Drop a file onto a terminal to upload it into the worktree and type its path.
- **Git panel** — beside every space and worker: branch, ahead/behind, the PR with its review state
  and checks, and the changed files (uncommitted, or against the PR's base). Click a file for a
  read-only diff. The toolbar also opens the folder in VS Code or your file manager.
- **Workers** — each dispatched worker is its own space with the git panel. **↗** opens your own
  space in its worktree; **×** closes it, optionally removing the worktree (a pushed branch or PR is
  untouched). When a worker's session ends, the cockpit asks whether to close it.
- **Terminals** reconnect on their own after a network drop or server restart and redraw on
  attach. The header's sun/moon toggles light and dark; claude sessions launched afterwards use the
  matching variant of your Claude Code theme.
- **Restart** — the header's `ctx` badge shows the orchestrator's context use and turns red past
  the Restart threshold. Click it → **Restart orchestrator** to relaunch it on a fresh session; it
  resumes from its ledgers, so nothing is lost. Between ticks, with no worker running, it compacts
  itself once context passes the Auto-compact threshold.
- The bottom-left pill shows the connection, the number of claude sessions, and the memory used by
  the cockpit and everything it spawned (physical footprint on macOS, resident memory on Linux).

## Settings

The header's ⚙ opens five tabs. Field-by-field reference: [`SETUP.md`](SETUP.md).

- **Projects** — every configured repo, filterable. Open one to see each field tagged *set here*
  or *default* (inherited from Defaults), change or reset overrides, and view the items Jeeves is
  tracking for it. **Add repos…** runs `/jeeves:setup --scan` in the orchestrator.
- **Defaults** — your identity, and the shared defaults every project inherits: Jira, Confluence,
  GitHub review scope and base branches, review command and seed files.
- **Agents** — the built-in agents (story worker, review resolver, verifier), each expandable to its
  model, tools and prompt; **Customise** one to run your own version in cockpit dispatches, **Reset
  to built-in** to drop it. A customised agent is flagged when a plugin update changes the
  built-in, with the new built-in beside yours to compare. Below, **Your agents**: **New agent**,
  edit and delete — a name, a one-line "when to use it" (Jeeves matches items against it), tools
  (none picked = all), model, and the prompt. Run one with `run <agent> on …`.
- **Jeeves** — models and effort for the orchestrator and workers; permission modes; loop cadence
  and daily summary; session hygiene (Restart threshold, how long a tab with no browser attached
  lives); push notifications; reminders (add, done, snooze, delete); constraints (the read-only
  baseline plus your additions); and the cockpit's address, with **Copy cockpit URL** and
  **Rotate token**.
- **Appearance** — the UI font and the code & terminal font, each picked from a searchable list of
  Google Fonts (or **System default**, or **Other Google Font…** for any family by name) with a
  live preview line, and the terminal font size. **Reset to defaults** restores Roboto,
  Roboto Mono and 13 px. Saved in `cockpit.json`, so every browser matches; a save applies in
  every open cockpit tab at once.

Model, permission and hygiene changes apply to sessions spawned afterwards; loop cadence,
notifications and constraints apply on the orchestrator's next Restart. A setting pinned by an
environment variable shows as read-only.

## Updating

Jeeves is two parts that update differently:

- **The engine** (this plugin: the loop's `BRIEF.md`, worker agents, commands, baseline rules,
  cockpit code) updates with the plugin — `/plugin` in Claude Code → update `jeeves` (or
  `claude plugin update`). The **cockpit UI rebuilds automatically** on the next launch when its
  source is newer than the last build; force it with `jeeves rebuild`. If the cockpit was running
  during an update, **restart it** (stop it and run `/jeeves:cockpit` again) to pick up server
  changes, then hard-reload the browser tab.
- **Your data home** (`~/jeeves`: identity, defaults, project configs, ledgers, reminders, your
  agents, cockpit settings) is yours and is **never touched** by an update. A customised built-in
  agent keeps your version for cockpit dispatches (headless dispatches use the plugin's); Settings →
  Agents flags it when the update changed the built-in. Your additions in
  `~/jeeves/loop-constraints.md` layer on top of the updated baseline.

A change that should reach everyone (loop logic, report shape, an agent) is a PR to this repo, not a
local edit — the engine is shared.

## Shortcuts — the `jeeves` terminal command

`/jeeves:cockpit` works in Claude Code with zero setup. To launch from a **plain terminal**, install
the one-word `jeeves` command:

```
jeeves              start the cockpit and open the browser
jeeves --no-open    start without opening a browser
jeeves rebuild      rebuild the UI, then start
```

**macOS / Linux** — `/jeeves:setup` offers to install it, or do it yourself:

```bash
bash "$(ls -d ~/.claude/plugins/cache/*/jeeves/*/bin ~/.claude/plugins/marketplaces/*/plugins/jeeves/bin 2>/dev/null | head -1)/jeeves-install-cli"
```

That writes a self-contained `jeeves` to `~/.local/bin` (pass a different dir as an argument) that
**resolves the newest installed plugin at runtime**, so it survives plugin updates. Add
`~/.local/bin` to your `PATH` if the installer says it isn't there.

**Windows** — run the same installer from **Git Bash**. Alongside the bash `jeeves` it writes
`jeeves.cmd` for PowerShell and cmd, which also resolves the newest installed plugin at runtime,
and prints the command that adds `~/.local/bin` to your user `PATH` if it isn't there. `jeeves
--where` prints the `cockpit.mjs` it would launch. Without Git Bash, point a shortcut at the
plugin's `bin\jeeves.cmd` (it moves with each plugin update):

```bat
dir /s /b "%USERPROFILE%\.claude\plugins\cache\*\jeeves\*\bin\jeeves.cmd"
```

Then run `jeeves` from any terminal. (`node` and `claude` must be on your `PATH`.)

## Windows

The cockpit server, launchers and lifecycle hooks are cross-platform; the UI is a browser. Notes:

- Use the **`.cmd`** launcher above, or the `/jeeves:cockpit` slash command.
- `node-pty` builds natively on first launch — you need the C++ build tools (see
  [Requirements](#requirements)). If the first launch fails building it, install the tools and run
  `jeeves rebuild`.
- Terminal tabs default to PowerShell; set the `SHELL` env var to pick another.
- The **Scratchpad** is rooted at `%USERPROFILE%`; override with `JEEVES_SCRATCH_ROOT`.
- Claude and codex tabs launch the real `.exe` behind npm's shim (found with `where.exe`).
- The bottom-left memory figure sums the working set of the server and everything it spawned.
- **Ctrl+C** in the `jeeves` window asks `Terminate batch job (Y/N)?` — answer `Y`. A cockpit that
  won't stop: `taskkill /PID <pid> /T /F` ends it together with the orchestrator, workers and tabs
  it started.
- Dev-linking the plugin (`bin/jeeves-devlink`) is macOS/Linux only; on Windows edit in the
  installed location or re-run the marketplace update.

## Troubleshooting

- **"data home not found"** → run `/jeeves:setup` first.
- **Cockpit shows no projects** → you haven't added any: `/jeeves:setup --scan` (or Settings →
  Projects → **Add repos…**).
- **Dashboard never fills** → the orchestrator hasn't painted yet; check its pane (left of the
  Jeeves view) for a question or an error.
- **A dashboard action doesn't appear after an update** → restart the cockpit *server* and
  hard-reload the browser; the running server may predate the change.
- **Reviews are skipped** → the session isn't in a git repo (headless runs only).
- **Another tab says unauthorized** → the token was rotated; open it with the URL from Settings →
  Jeeves → Cockpit → **Copy cockpit URL**.
- **Port already in use** → set `PORT` (default `4177`) before launching.
- **A worker couldn't report ("cockpit MCP down")** → happens if the cockpit restarts mid-flight;
  the worker also leaves its result in `JEEVES_REPORT.md` in its worktree and in a message to the
  orchestrator, so the loop collects it on the next tick.
