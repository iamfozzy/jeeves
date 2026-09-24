#!/usr/bin/env node
// PreToolUse hook for the orchestrator: blocks Edit/Write/MultiEdit on the data
// home's ledgers (projects/*/state.md, reminders.md), which it must write through
// the cockpit's write_state tool so state diffs never fill the user's terminal.
// Exit 2 refuses the call and hands the reason to the session; anything else, or
// input it can't read, exits 0 — a guard must never block on doubt.
import { normalize, relative, sep } from 'node:path'

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
try { file = JSON.parse(await readStdin()).tool_input?.file_path } catch {}
if (typeof file !== 'string' || !file) process.exit(0)

const rel = relative(normalize(home), normalize(file))
const parts = rel.split(sep)
const ci = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s
const ledger = !rel.startsWith('..')
  && ((parts.length === 1 && ci(parts[0]) === 'reminders.md')
    || (parts.length === 3 && ci(parts[0]) === 'projects' && ci(parts[2]) === 'state.md'))
if (!ledger) process.exit(0)

const which = parts.length === 1 ? `{ file: "reminders", markdown }` : `{ project: "${parts[1]}", markdown }`
process.stderr.write(`Blocked: under the cockpit, ${rel} is written with mcp__cockpit__write_state(${which}), the whole file, never Edit/Write, so state diffs stay out of the user's terminal. Resend it through write_state (load it with ToolSearch if it's deferred).\n`)
process.exit(2)
