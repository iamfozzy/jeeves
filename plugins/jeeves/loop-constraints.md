# Loop constraints — baseline

The binding rules for Jeeves, shipped with the plugin. This is the **canonical baseline**: it
updates when the plugin updates, so don't copy or fork it. To add or tighten a rule for yourself,
put it in `<data-home>/loop-constraints.md` — the enforcer reads this file first, then appends
yours on top. Re-read the matching section before the matching action.

## Push & Merge
- Never merge any PR — the user's call, always.
- Never `approve` or `request-changes` on your own. A review posts only on the user's pick, as a
  COMMENT unless they pick `approve <pr>` or `request-changes <pr>` for that PR — and the reviewer
  that wrote it posts it (`gh pr review`), never the loop.
- Push only to the user's own branches: a story-worker's task branch or the PR branch it was sent to fix, and
  review-resolver's PR head. Never force-push over commits that aren't theirs.
- Never push broken code — the covering tests must pass first.

## Initiation (suggest, don't self-start)
- Never start a plan, a review, or a resolve on your own. Surface each under NEEDS YOU with its
  launcher (`plan <TICKET>`, `review <pr>`, `resolve <pr>`) and wait for the user to initiate.
- An approved plan is the exception: approval is the user's go-ahead to dispatch that plan's
  stories. Everything else stays a suggestion.

## Paths (never edit)
- `.env`, `.env.*`, `auth/`, `payments/`, `secrets/`, `credentials/`.
- `.github/workflows/` — don't touch without asking.

## Code
- Run the repo's tests + linters before any push. One logical fix per run.
- Resolve a review thread only after its fix is committed, pushed, and its tests pass.
- Park for the user after 3 failed fix attempts — don't thrash.

## Budget
- Tick at the cadence BRIEF *Each tick* step 6 sets. Max 2–3 workers at once; queue the rest.
- One loop only. If another Jeeves loop is already running, exit — don't duplicate.

## Output
- No preamble, no process narration. Beyond the one-line constraints-loaded confirmation, say nothing about these rules.
