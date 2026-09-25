#!/usr/bin/env node
// PreToolUse hook for the orchestrator, which dispatches work and never does it.
//   guard-orchestrator.mjs <data-home> <plugin-root>
// It runs on every tool call and holds the few lines the dispatch design draws:
//  - Read/Grep/Glob, Bash, MCP tools and the loop's built-ins run anywhere. Bash is not
//    parsed: the brief carries the rule (status and housekeeping yes, investigation no).
//  - Edit/Write/NotebookEdit reach the data home and the orchestrator's own Claude memory
//    folder (<claude config>/projects/<data-home slug>/memory), never the data home's
//    ledgers (projects/*/state.md, reminders.md) — those go through the cockpit's
//    write_state, so state diffs never fill the user's terminal — nor the cockpit's own
//    state (<data-home>/.cockpit).
//  - Agent/Task/Workflow are refused: agents run through dispatch, which gives them a
//    worktree, report() and a dashboard row.
//  - Skill refuses review workflows (a reviewer's job) and /jeeves:setup (a tab of its own).
//  - AskUserQuestion is refused: the loop never waits on the user.
// Exit 2 refuses the call and hands the reason to the session. It fails closed: input it
// can't read and any error of its own refuse (Claude Code takes any other non-zero exit as
// "allow"). Only its own logging never blocks.
import { appendFileSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

const refuse = (why) => { process.stderr.write(`Blocked: ${why} — the orchestrator guard refuses what it can't check.\n`); process.exit(2) }

const [, , home] = process.argv
if (!home) refuse('the guard was started without its data-home argument')

// Claude Code writes the hook input (JSON with tool_name, tool_input, cwd) to stdin and
// closes it. Read to the end; STDIN_MS only stops a stdin that never closes.
const STDIN_MS = 10000
function readStdin() {
  return new Promise((res) => {
    if (process.stdin.isTTY) return res('')
    let data = ''
    const done = () => { clearTimeout(t); res(data) }
    const t = setTimeout(done, STDIN_MS)
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => { data += d })
    process.stdin.on('end', done)
    process.stdin.on('error', done)
  })
}

let input
try { input = JSON.parse(await readStdin()) } catch {}
if (!input || typeof input !== 'object' || typeof input.tool_name !== 'string') refuse('the hook input was missing or not JSON')
const tool = input.tool_name, ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}, cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : home
// Each refusal is logged to <data-home>/guard.log (one JSON line; trimmed to its last
// 500 lines past 256 KB) so Settings can show what the orchestrator was stopped from.
const LOG = join(home, 'guard.log')
function logBlock(why) {
  try {
    const what = String(ti.file_path ?? ti.notebook_path ?? ti.skill ?? ti.subagent_type ?? ti.description ?? '').slice(0, 300)
    appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), tool, what, why: why.replace(/^Blocked: /, '').split(' Dispatch it')[0].slice(0, 240) }) + '\n')
    if (statSync(LOG).size > 256 * 1024) writeFileSync(LOG, readFileSync(LOG, 'utf8').trimEnd().split('\n').slice(-500).join('\n') + '\n')
  } catch {}
}
const block = (why) => { logBlock(why); process.stderr.write(why + '\n'); process.exit(2) }
const allow = () => process.exit(0)
const DISPATCH = 'Dispatch it: mcp__cockpit__dispatch with "story-worker" to change code, "investigator" to look into something, "loop-verifier" to check a result.'

// APFS (macOS) and NTFS (Windows) both fold case by default, so a ledger name written in
// another case still has to match.
const ci = (s) => s.toLowerCase()
// A path resolved against the session's cwd with every symlink followed. One that doesn't
// exist yet (a file about to be written) resolves through its nearest existing ancestor,
// so a symlinked data home still matches.
const real = (p) => { try { return realpathSync(p) } catch { const up = dirname(p); return up === p ? normalize(p) : join(real(up), basename(p)) } }
const at = (p) => real(resolve(cwd, p))
// The path of p inside root, or null when it's outside.
const inside = (root, p) => {
  const r = relative(real(resolve(root)), at(p))
  return r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r) ? r : null
}
// Claude Code keeps a session's memory in <config>/projects/<slug>/memory, the slug being
// the cwd with every character but a letter or digit turned into '-'. The orchestrator runs
// in the data home; either spelling of it (as given, or with symlinks followed) may be the one.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const slug = (p) => p.replace(/[^A-Za-z0-9]/g, '-')
const MEMORY = [...new Set([resolve(home), real(resolve(home))])].map((h) => join(CLAUDE_DIR, 'projects', slug(h), 'memory'))
// A data-home ledger (projects/*/state.md, reminders.md), as its path parts, or null.
function ledgerOf(rel) {
  const parts = rel.split(sep)
  return (parts.length === 1 && ci(parts[0]) === 'reminders.md') || (parts.length === 3 && ci(parts[0]) === 'projects' && ci(parts[2]) === 'state.md') ? parts : null
}
// Skills that do a worker's job: a review (the reviewer's), a PR (the story-worker's), a
// cleanup pass over code.
const WORKER_SKILL = /(^|:)([\w-]*review[\w-]*|simplify|create-pr)$/i

function main() {
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') {
    const file = ti.file_path ?? ti.notebook_path
    if (typeof file !== 'string' || !file) block(`Blocked: ${tool} needs a file_path.`)
    if (MEMORY.some((m) => inside(m, file) !== null)) allow()
    const rel = inside(home, file)
    if (rel === null) block(`Blocked: you're the orchestrator — you edit only the data home and your memory, never ${file}. Changing code is a worker's job. ${DISPATCH}`)
    if (rel === '.cockpit' || rel.startsWith('.cockpit' + sep)) block(`Blocked: ${file} is the cockpit's own state (tokens, session files) — never edited by the orchestrator.`)
    const parts = ledgerOf(rel)
    if (!parts) allow()
    const which = parts.length === 1 ? `{ file: "reminders", edits: [{ old, new }] }` : `{ project: "${parts[1]}", edits: [{ old, new }] }`
    block(`Blocked: ${rel} is changed with mcp__cockpit__write_state(${which}) — the same old/new as Edit (or markdown for the whole file) — never Edit/Write, so state diffs stay out of the user's terminal. Resend it through write_state (load it with ToolSearch if it's deferred).`)
  }

  if (tool === 'Agent' || tool === 'Task' || tool === 'Workflow') block(`Blocked: agents run through mcp__cockpit__dispatch, never the ${tool} tool — dispatch gives them a worktree, report() and a dashboard row. ${DISPATCH}`)

  if (tool === 'Skill') {
    const name = String(ti.skill || '').replace(/^\//, '').trim().split(/\s+/)[0]
    if (name === 'jeeves:setup') block(`Blocked: /jeeves:setup runs in a tab of its own, never in the orchestrator — open it with mcp__cockpit__add_tab({ space: "scratch", prompt: "/jeeves:setup --scan" }) (or the arguments the user gave).`)
    if (WORKER_SKILL.test(name)) block(`Blocked: ${name} is a worker's job — a review goes to the reviewer (dispatch it with "reviewer"), a PR or code change to the story-worker. ${DISPATCH}`)
    allow()
  }

  if (tool === 'AskUserQuestion') block('Blocked: the orchestrator never waits on a question — raise it under NEEDS YOU in the tick report and carry on.')
  allow()
}
try { main() } catch (e) { refuse(`the guard failed (${e?.message || e})`) }
