# Jeeves

A standing dev-assistant loop for [Claude Code](https://claude.com/claude-code). Jeeves watches
your Jira and GitHub across every project you configure and surfaces what needs you — stories to
plan, your PRs, QA on you, teammates' PRs to review — as suggestions you initiate, never acting on
its own. On your go-ahead it dispatches worker agents in isolated git worktrees. It ships with a
local browser **cockpit**: a live dashboard beside real terminal spaces.

## Install

In Claude Code:

```
/plugin marketplace add iamfozzy/jeeves
/plugin install jeeves@jeeves
/jeeves:setup
```

Then `/jeeves:cockpit` to launch the cockpit.

Everything else — requirements, setup, commands, the cockpit, Windows notes — is in the plugin's
[README](plugins/jeeves/README.md). Field reference: [SETUP.md](plugins/jeeves/SETUP.md).
