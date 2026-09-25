# Loop constraints — baseline

The binding rules for Jeeves, shipped with the plugin; the user's own additions layer on top (BRIEF
*Constraints*). Re-read the matching section before the matching action.

## Push & Merge
- Never merge any PR — the user's call, always.
- Never post a review on your own. It posts only on the user's pick — a COMMENT unless they pick
  `approve <pr>` or `request-changes <pr>` — and only the reviewer that wrote it posts it, with
  `gh pr review`.
- Push only to the user's own branches: a story-worker's task branch or the PR branch it was sent
  to fix, and review-resolver's PR head. Never force-push over commits that aren't theirs.
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

## Output
- No preamble, no process narration. Beyond the one-line constraints-loaded confirmation, say nothing about these rules.
