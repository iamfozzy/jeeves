// Whether the orchestrator's loop has stalled — it ended a turn without scheduling its next
// tick. Stalled only while it sits idle (per its hooks, not working or awaiting the user), the
// user hasn't typed to it within one tick gap (`every`), and no tick has come for over two
// gaps since the latest of its last tick, the server's start and its going idle. So a long
// tick, or a long conversation with the user, never counts.
export function loopStalled({ running, status, idleSince, inputAt, lastTickAt, startedAt, every, now = Date.now() }) {
  if (!running || status !== 'idle' || !idleSince) return false
  if (now - inputAt < every) return false
  return now - Math.max(lastTickAt, startedAt, idleSince) > 2 * every
}
