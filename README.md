<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="plugins/jeeves/cockpit/public/brand/jeeves-wordmark-dark.svg">
    <img src="plugins/jeeves/cockpit/public/brand/jeeves-wordmark-light.svg" alt="Jeeves" width="280">
  </picture>
</p>

<p align="center">
  <b>A standing dev assistant for <a href="https://claude.com/claude-code">Claude Code</a>.</b><br>
  It watches your Jira and GitHub, tells you what needs you, and does the work when you say so.
</p>

---

You come back from a meeting to four review requests, a failing check on your own PR, a ticket
that moved to In Progress overnight, and a QA handoff you'd forgotten about. Jeeves has already
noticed all of it. It keeps a live dashboard of everything across every repo you work in, ranks it
by what needs you, and waits.

Say `plan ABC-123` and it drafts a plan on the ticket. Say `approve ABC-123` and it dispatches
worker agents, one per story, each in its own git worktree, each opening its own PR. Say
`review 1860` and it reviews a teammate's PR, then asks you how to post it. **It never acts on its
own, never merges, and never posts a review you didn't pick the verdict for.**

## What you get

- **One dashboard for everything** — stories assigned to you this sprint, your open PRs with
  checks and review state, tickets waiting on your QA, teammates' PRs to review, workers in
  flight, and your reminders. Red means act, yellow means watch, and calm rows fold away.
- **Plan before code** — a ticket entering In Progress surfaces a `plan` suggestion. The plan is
  published to Confluence, linked from the ticket, and revised from ticket comments until you
  approve it.
- **Workers that ship PRs** — approved stories run in parallel where their dependencies allow.
  Each worker bootstraps its own worktree, implements, runs the tests, opens a PR and reports back.
  `resolve <pr>` addresses review feedback on your own PRs and resolves the threads it fixed.
- **A browser cockpit** — the orchestrator and dashboard side by side, plus real terminal spaces
  (`claude`, `codex`, shell) per branch, PR or worktree, each with a git panel of changes, PR
  status and diffs. ⌘P jumps anywhere.
- **Cheap to leave running** — a tick costs one GitHub query and one Jira query, however many
  repos you watch. It ticks faster while workers run, slower overnight, and keeps working with the
  browser closed.
- **Yours, and local** — everything runs on your machine. The cockpit is loopback-only and
  token-gated, and your config, ledgers and reminders live in a data home that updates never touch.

## How it works

```
               ┌───────────────── the cockpit (localhost:4177) ─────────────────┐
  Jira ──┐     │  orchestrator (claude, /loop)  ──paints──▶  dashboard           │
         ├──▶  │        │                                                        │
  GitHub ┘     │        └── dispatch ──▶ workers (claude, one per git worktree)  │
               │                            └── report ──▶ orchestrator         │
               └────────────────────────────────────────────────────────────────┘
```

The **orchestrator** is a Claude Code session running a self-paced loop from the plugin's
[`BRIEF.md`](plugins/jeeves/BRIEF.md). Each tick it queries GitHub and Jira, reconciles the
results with its per-project ledgers, and repaints the dashboard with only what changed. The
**cockpit** is a small Node server that hosts the orchestrator, the workers and your terminals as
PTYs, and exposes the MCP tools the orchestrator drives: dispatch, report, paint, open a space.
Without a browser, `/jeeves:start` runs the same loop headless.

## Talking to Jeeves

Type into the orchestrator pane, or fire the same commands from any dashboard row's ⋮ menu.

| Command | Does |
|---|---|
| `plan <TICKET>` | Drafts a Confluence plan with a story breakdown and links it from the ticket. |
| `approve <TICKET>` | Approves the plan: one worker per story, in parallel where dependencies allow. |
| `change <TICKET>: …` | Revises the plan. Comments on the ticket work too. |
| `review <pr>` | Reviews a teammate's PR with your review command (default `/code-review`). |
| `comment` / `approve` / `request-changes <pr>` | Posts the finished review with that verdict. |
| `resolve <pr>` | Addresses change requests on your own PR, pushes, and resolves the threads. |
| `qa <KEY>` | Prints the ticket's testing instructions. |
| `run <agent> on <target>` | Runs one of your own agents on a ticket, PR or repo. |
| `remind in 2h …` | Sets a reminder that surfaces, and notifies you, when it's due. |

## Get started

**You'll need** Claude Code, Node.js 20+, the GitHub CLI signed in (`gh auth login`), the
Atlassian Rovo MCP connected in Claude Code for Jira and Confluence, and a C/C++ toolchain for the
terminal library (`xcode-select --install` on macOS, `build-essential` on Linux, Visual Studio
Build Tools on Windows).

In Claude Code:

```
/plugin marketplace add iamfozzy/jeeves
/plugin install jeeves@jeeves
/jeeves:setup              # your identity and shared defaults, once
/jeeves:setup --scan       # pick the repos to watch from your dev folder
/jeeves:cockpit            # launch the cockpit in your browser
```

The first launch installs dependencies and builds the UI (about a minute). Setup also offers a
`jeeves` terminal command, so you can launch the cockpit without opening Claude Code. It works on
macOS, Linux and Windows.

## Documentation

- [**Plugin guide**](plugins/jeeves/README.md) — everyday use, the dashboard, spaces and
  terminals, settings, updating, Windows notes and troubleshooting.
- [**Setup reference**](plugins/jeeves/SETUP.md) — every field in `identity.md`, `defaults.md`,
  `project.md` and `cockpit.json`, plus environment variables.
- [**Cockpit internals**](plugins/jeeves/cockpit/README.md) — the server, MCP tools, auth and
  persistence.
- [**The loop**](plugins/jeeves/BRIEF.md) — the orchestrator's operating brief.

## License

[MIT](LICENSE)
