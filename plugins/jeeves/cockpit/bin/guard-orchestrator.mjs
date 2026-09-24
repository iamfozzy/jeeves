#!/usr/bin/env node
// PreToolUse hook for the orchestrator, which dispatches work and never does it:
//  - Edit/Write outside the data home (and the temp dir) is refused: code changes
//    belong to a dispatched story-worker, investigation to an investigator.
//  - The data home's ledgers (projects/*/state.md, reminders.md) are written through
//    the cockpit's write_state tool, so state diffs never fill the user's terminal.
// Exit 2 refuses the call and hands the reason to the session; anything else, or
// input it can't read, exits 0 — a guard must never block on doubt.
import { tmpdir } from 'node:os'
import { isAbsolute, normalize, relative, sep } from 'node:path'

const [, , home] = process.argv
if (!home) process.exit(0)

// Claude Code writes the hook input (JSON with tool_input) to stdin; never wait long.
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

let file
try { const i = JSON.parse(await readStdin()).tool_input; file = i?.file_path ?? i?.notebook_path } catch {}
if (typeof file !== 'string' || !file) process.exit(0)

const ci = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s
const under = (root) => { const r = relative(normalize(root), normalize(file)); return r && !r.startsWith('..') && !isAbsolute(r) ? r : null }
const block = (why) => { process.stderr.write(why + '\n'); process.exit(2) }

const rel = under(home)
if (rel === null) {
  if (under(tmpdir()) !== null || under('/tmp') !== null) process.exit(0)
  block(`Blocked: you're the orchestrator — you never edit files outside the data home (${file}). Dispatch the work instead: mcp__cockpit__dispatch with agent "story-worker" to change code, or "investigator" to look into something.`)
}
const parts = rel.split(sep)
const ledger = (parts.length === 1 && ci(parts[0]) === 'reminders.md')
  || (parts.length === 3 && ci(parts[0]) === 'projects' && ci(parts[2]) === 'state.md')
if (!ledger) process.exit(0)

const which = parts.length === 1 ? `{ file: "reminders", markdown }` : `{ project: "${parts[1]}", markdown }`
block(`Blocked: under the cockpit, ${rel} is written with mcp__cockpit__write_state(${which}), the whole file, never Edit/Write, so state diffs stay out of the user's terminal. Resend it through write_state (load it with ToolSearch if it's deferred).`)
