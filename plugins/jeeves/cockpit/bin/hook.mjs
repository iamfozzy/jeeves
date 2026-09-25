#!/usr/bin/env node
// Cross-platform Claude Code lifecycle hook: POSTs { id, status, sessionId } to the
// cockpit's /api/hook ($JEEVES_HOOK_URL, which carries the hook token and is set in every
// session the cockpit launches, so the token is never on a command line) so a session's dot reflects working / awaiting / idle / offline,
// and so the cockpit follows the live session id (it changes on /clear and /resume,
// and a respawn must resume the current one). Used
// instead of a curl one-liner so it runs the same on macOS, Linux and Windows
// (no shell redirection, no curl dependency). Always exits 0 — a hook must never
// fail its session.
import http from 'node:http'

const [, , id, status] = process.argv
const url = process.env.JEEVES_HOOK_URL
if (!id || !status || !url) process.exit(0)

// Claude Code writes the hook input (JSON with session_id) to stdin. Read it, but
// never wait long: a missing or unterminated stdin must not stall the session.
function readStdin() {
  return new Promise((res) => {
    if (process.stdin.isTTY) return res('')
    let data = ''
    const done = () => res(data)
    setTimeout(done, 500)
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => { data += d })
    process.stdin.on('end', done)
    process.stdin.on('error', done)
  })
}

let sessionId
try { sessionId = JSON.parse(await readStdin()).session_id } catch {}

try {
  const u = new URL(url)
  const req = http.request(
    { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 2000 },
    (res) => { res.resume(); res.on('end', () => process.exit(0)) }
  )
  req.on('error', () => process.exit(0))
  req.on('timeout', () => { try { req.destroy() } catch {} process.exit(0) })
  req.end(JSON.stringify({ id, status, sessionId }))
} catch { process.exit(0) }
