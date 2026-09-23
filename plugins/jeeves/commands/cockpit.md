---
description: Start the Jeeves Cockpit — the local browser UI for the monitoring loop — and hand back its URL.
disable-model-invocation: true
---

# Jeeves — open the cockpit

Start the cockpit server in the background and give the user its URL. Do nothing else — no preamble, no status narration.

1. Run, in the background (do not wait for it to exit — it is a long-running server):

   `node "${CLAUDE_PLUGIN_ROOT}/cockpit/bin/cockpit.mjs"`

2. The first run installs dependencies and builds the UI (~1 minute); later runs start immediately. Watch its output for the line:

   `open (prod):  http://localhost:4177/?token=…`

3. Give the user that **full URL** (including the `?token=…`) as a clickable link, and tell them it is also opening in their browser. If the output shows an error instead (e.g. `node` missing, port in use), surface that line verbatim.

The cockpit runs entirely on the user's machine — loopback-only, token-gated — and boots its own Jeeves orchestrator. Each teammate runs their own; nothing is shared over the network.
