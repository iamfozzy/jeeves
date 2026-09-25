---
description: Bootstrap Jeeves for a new user, or add projects — creates the data home, writes identity.md and the shared defaults.md, and creates minimal project configs one at a time or in bulk from a scan of your dev root.
argument-hint: "[project name | --scan [dir]]"
disable-model-invocation: true
---

# Jeeves — setup & scaffold

Bootstrap Jeeves for this user, or add projects. You write files into the **data home**; you
read templates from the **engine**. Never write into the engine.

- **Data home** = `$JEEVES_HOME` if set, else `~/jeeves`. Create it if missing.
- **Templates** = `${CLAUDE_PLUGIN_ROOT}/templates/`.

Full walkthrough and the field reference: `${CLAUDE_PLUGIN_ROOT}/SETUP.md`. Read it before you
start so you ask for the right things.

## What `$ARGUMENTS` means
- Empty → **first-time setup** (§1–2), then offer `--scan`.
- A name (e.g. `web`, or a repo slug) → **add that one project** (§3).
- `--scan [dir]` → **bulk-add** repos found under `dir` (default: identity's dev root) (§4).

Any mode first runs §1 if `identity.md` is missing and §2 if `defaults.md` is missing.

## 1. Identity (only if `<data-home>/identity.md` is missing)
1. Create the data home and `projects/` inside it.
2. **Don't copy the constraints.** The baseline rules live in the plugin
   (`${CLAUDE_PLUGIN_ROOT}/loop-constraints.md`) and update automatically. Only create
   `<data-home>/loop-constraints.md` if they want to add their own rules — and then write it as a
   header-only **additions** stub (see `${CLAUDE_PLUGIN_ROOT}/templates/loop-constraints.additions.md`),
   never a copy of the baseline. No local file → the baseline applies unchanged.
3. Gather identity — ask for these, don't guess:
   - **gh login** (their GitHub username; confirm with `gh api user -q .login` if `gh` is authed).
   - **Jira email** (the address Jira knows them by; default to their Claude account email if it
     looks right, but confirm).
   - **display name** (first name is fine; names their Confluence plans folder `Plans > <name>`).
   - **dev root** (where their repo checkouts live, e.g. `~/Dev`; a project's local path defaults
     to `<dev-root>/<repo-name>`).
   Write `<data-home>/identity.md` from `${CLAUDE_PLUGIN_ROOT}/templates/identity.md`, filling the
   fields. This file is personal — it is never shared. Leave `confluence plans folder id` blank; the
   loop resolves-or-creates it on the first plan.

## 2. Shared defaults (only if `<data-home>/defaults.md` is missing)
Every project inherits `defaults.md`; a project's `project.md` holds only what differs. Write it
from `${CLAUDE_PLUGIN_ROOT}/templates/defaults.md`, asking once for: Jira cloudId + site, the plan
trigger status, the QA-assignee field id and QA column names, Confluence space + Plans folder, the
base-branch conventions, and worktree seed files. Don't invent ids — leave a placeholder and say
that feature stays off until it's filled.

## 3. Add one project
Ask only what the defaults and the checkout can't answer: the repo slug (`owner/repo`; derive it
from `git remote get-url origin` when the checkout exists), its Jira key (or none), and any field
that differs from the defaults (e.g. `review scope: repo`). Then create it as §5.

## 4. Bulk-add: `--scan [dir]`
1. **Discover** — one Bash call over `dir` (`<base branches>` and `<seed files>` from `defaults.md`):
   ```
   find <dir> -maxdepth 3 -type d -name .git -prune 2>/dev/null | sed 's#/\.git$##' | while read -r d; do
     url=$(git -C "$d" remote get-url origin 2>/dev/null) || continue
     slug=$(printf %s "$url" | sed -E 's#\.git$##; s#^.*[:/]([^/]+/[^/]+)$#\1#')
     head=$(git -C "$d" symbolic-ref --short -q refs/remotes/origin/HEAD | sed 's#^origin/##')
     base=$(for b in <base branches>; do git -C "$d" rev-parse -q --verify "refs/remotes/origin/$b" >/dev/null && { echo "$b"; break; }; done)
     key=$(git -C "$d" log -200 --all --format=%s | grep -oE '\b[A-Z][A-Z0-9]+-[0-9]+' | sed 's/-[0-9]*$//' | sort | uniq -c | sort -rn | awk 'NR==1{print $2}')
     seed=$(for f in <seed files>; do [ -f "$d/$f" ] && printf '%s ' "$f"; done)
     echo "$slug|$d|${base:-$head}|$head|${key:--}|${seed:--}"
   done
   ```
   Each line: `slug|path|base|origin-default|guessed Jira key|seed files present`. Repos without
   an `origin` are skipped (Jeeves needs a GitHub slug).
2. **Filter** — drop every repo already configured: its slug or path matches a
   `<data-home>/projects/*/project.md` (the BRIEF Step 0 index command lists them). Two checkouts
   of one slug → list both, the user picks one.
3. **Show** the rest as one numbered table — `# · slug · path · base · Jira key (guess)` — and ask
   which to add: `all`, a list/ranges (`1-5,9`), or `none`, with corrections inline (`3=ABC`,
   `4=nojira`, `7 base=main`). The key is a guess from commit subjects; say so. Nothing is written
   until they answer.
4. **Create** each selected repo as §5, then report one line: created N, skipped M (and why).

## 5. Creating a project (§3 and §4)
- **id** = the repo name (last segment of the slug); taken by another repo → `<owner>-<repo>`.
- **Minimal fields only**: `repo`; `base branch` only when it isn't origin's default; `path` only
  when it isn't `<dev-root>/<repo name>`; `project key` when it has Jira; plus any field the user
  set that differs from `defaults.md`. Frontmatter `reviewCommand` and `seedFiles` are inherited
  from the defaults (a seed file missing from a checkout is skipped) — set them only to differ.
- Write `<data-home>/projects/<id>/project.md` from
  `${CLAUDE_PLUGIN_ROOT}/templates/project.template.md` (dropping unset fields, adding any overrides
  by the defaults' bold label, and `reviewCommand` / `seedFiles` as frontmatter only when they
  differ) and `state.md` from `${CLAUDE_PLUGIN_ROOT}/templates/state.md`. A running cockpit picks
  the new project up on its own.
- Never overwrite an existing `project.md` or `state.md` — those are live config and memory.

## 6. Offer the `jeeves` terminal command
After first-time setup (identity created), offer to install the **`jeeves`** terminal command so
they can launch the cockpit from any terminal — `jeeves` runs the whole thing (the loop's
orchestrator + the browser UI). On a yes, run:

    bash "${CLAUDE_PLUGIN_ROOT}/bin/jeeves-install-cli"

It writes a small self-contained `jeeves` wrapper to `~/.local/bin` (override with an argument) that
resolves the installed plugin at runtime, so it survives plugin updates. Relay its output verbatim —
especially the PATH note if `~/.local/bin` isn't on their `PATH`. (Windows: point a shortcut at
`bin\jeeves.cmd`, per the plugin README.) Either way they can always launch it in-session with
`/jeeves:cockpit`, or run the loop headless with `/jeeves:start` from a repo.

## Customising
- **Rules** — their own extra or tightened rules go in `<data-home>/loop-constraints.md` (§1 step
  2), never in the baseline.
- **Shared behaviour** (Jira/QA fields, Confluence, base branches, seed files) lives in
  `defaults.md`; **one repo's differences** (review scope, a review policy, protected paths, an
  attribution rule) go in its `project.md`, overriding the defaults.
- **The engine** (`BRIEF.md`, the agents, the baseline rules) is shared and updates with the
  plugin — a change that should reach everyone is a PR to this repo.

Keep it short. Ask only what you can't safely derive, write the files, confirm, done.
