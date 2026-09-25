#!/usr/bin/env node
// PreToolUse hook for the orchestrator, which dispatches work and never does it.
//   guard-orchestrator.mjs <data-home> <plugin-root>
// It runs on every tool call and allows only what it names, by tool name and structured
// arguments; everything else is refused.
//  - Read/Grep/Glob reach only its own files: the data home, the plugin, the temp dir,
//    this session's spilled tool results, and a worker's JEEVES_REPORT.md in a worktree.
//  - Edit/Write reach only the data home, and never its ledgers (projects/*/state.md,
//    reminders.md): those go through the cockpit's write_state tool, so state diffs never
//    fill the user's terminal.
//  - Skill runs only `loop`; the cockpit's own MCP tools and a fixed set of Atlassian
//    reads and writes run; every other built-in and MCP tool (Bash, Agent, Slack, …) is
//    refused, pointing at dispatch or NEEDS YOU.
// Exit 2 refuses the call and hands the reason to the session. It fails closed: input it
// can't read and any error of its own refuse (Claude Code takes any other non-zero exit as
// "allow"). Only its own logging never blocks.
import { appendFileSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

const refuse = (why) => { process.stderr.write(`Blocked: ${why} — the orchestrator guard refuses what it can't check.\n`); process.exit(2) }

const [, , home, pluginRoot] = process.argv
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
    const what = String(ti.command ?? ti.file_path ?? ti.notebook_path ?? ti.path ?? ti.pattern ?? ti.skill ?? ti.url ?? ti.subagent_type ?? '').slice(0, 300)
    appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), tool, what, why: why.replace(/^Blocked: /, '').split(' Dispatch it instead')[0].slice(0, 240) }) + '\n')
    if (statSync(LOG).size > 256 * 1024) writeFileSync(LOG, readFileSync(LOG, 'utf8').trimEnd().split('\n').slice(-500).join('\n') + '\n')
  } catch {}
}
const block = (why) => { logBlock(why); process.stderr.write(why + '\n'); process.exit(2) }
const allow = () => process.exit(0)
const DISPATCH = 'Dispatch it instead: mcp__cockpit__dispatch with agent "story-worker" to change code, "investigator" to look into something, "loop-verifier" to check a result.'

const ci = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s
// A path resolved against the session's cwd with every symlink followed. One that doesn't
// exist yet (a file about to be written) resolves through its nearest existing ancestor,
// so /tmp/new.md and /private/tmp/new.md, or a symlinked data home, still match.
const real = (p) => { try { return realpathSync(p) } catch { const up = dirname(p); return up === p ? normalize(p) : join(real(up), basename(p)) } }
const at = (p) => real(resolve(cwd, p))
// The path of p inside root, or null when it's outside.
const inside = (root, p) => {
  if (!root) return null
  const r = relative(real(resolve(root)), at(p))
  return r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r) ? r : null
}
// Claude Code saves a tool result too big for the conversation (a large Jira search) under
// <transcript dir>/<session id>/tool-results/ and hands the model the path; that folder is
// this session's own output, so it reads as its own file.
const spill = typeof input.transcript_path === 'string' && typeof input.session_id === 'string' && /^[\w-]+$/.test(input.session_id)
  ? join(dirname(input.transcript_path), input.session_id, 'tool-results') : null
// A worker's report: a JEEVES_REPORT.md (after symlinks) inside a `<repo>-worktrees/` folder.
const report = (p) => {
  const r = at(p)
  if (basename(r) !== 'JEEVES_REPORT.md') return false
  try { if (!statSync(r).isFile()) return false } catch { return false }
  return dirname(r).split(sep).some((d) => d.endsWith('-worktrees'))
}
const ownFile = (p) => [home, pluginRoot, tmpdir(), '/tmp', spill].some((root) => inside(root, p) !== null) || report(p)
// The folder a glob can reach: its folders up to the first wildcard, resolved against base.
const globRoot = (pattern, base) => { const i = pattern.search(/[*?[{]/); return resolve(base, (i < 0 ? pattern : pattern.slice(0, i)).replace(/[^/\\]*$/, '') || '.') }
const UP = /(^|[/\\])\.\.([/\\]|$)/
// A data-home ledger (projects/*/state.md, reminders.md), as its path parts, or null.
function ledgerOf(rel) {
  const parts = rel.split(sep)
  return (parts.length === 1 && ci(parts[0]) === 'reminders.md') || (parts.length === 3 && ci(parts[0]) === 'projects' && ci(parts[2]) === 'state.md') ? parts : null
}

const PLAIN = new Set(['ToolSearch', 'ScheduleWakeup', 'SendMessage', 'ListAgents', 'PushNotification'])
// The Atlassian tools the loop uses: ticket and page reads, plan pages and their link to the
// ticket, comments, transitions.
const ATLASSIAN = new Set(['getJiraIssue', 'searchJiraIssuesUsingJql', 'fetch', 'search', 'getConfluencePage', 'getConfluencePageFooterComments',
  'getConfluencePageInlineComments', 'getConfluencePageDescendants', 'getPagesInConfluenceSpace', 'getConfluenceSpaces', 'searchConfluenceUsingCql',
  'getAccessibleAtlassianResources', 'atlassianUserInfo', 'lookupJiraAccountId', 'getTransitionsForJiraIssue', 'createConfluencePage',
  'updateConfluencePage', 'addCommentToJiraIssue', 'transitionJiraIssue', 'addTeamworkGraphContext'])

function main() {
  if (PLAIN.has(tool) || tool.startsWith('mcp__cockpit__')) allow()
  const mcp = tool.match(/^mcp__(.+?)__(.+)$/)
  if (mcp) {
    if (/Atlassian|Jira/.test(mcp[1]) && ATLASSIAN.has(mcp[2])) allow()
    block(`Blocked: the orchestrator's MCP tools are the cockpit's and a fixed set of Jira/Confluence reads and writes — not ${tool}. If the user needs it done, raise it under NEEDS YOU; if it's work, ${DISPATCH}`)
  }

  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') {
    const p = ti.file_path ?? ti.path ?? cwd
    if (typeof p !== 'string') block(`Blocked: ${tool} needs a string path.`)
    const g = tool === 'Glob' ? ti.pattern : tool === 'Grep' ? ti.glob : null // Grep's pattern is a regex, not a path
    if (typeof g === 'string' && UP.test(g)) block(`Blocked: a ${tool} pattern never climbs out with \`..\` — give it a path instead.`)
    const reach = [p]
    if (tool === 'Glob' && typeof ti.pattern === 'string') reach.push(globRoot(ti.pattern, resolve(cwd, p)))
    if (tool === 'Grep' && typeof ti.glob === 'string' && isAbsolute(ti.glob)) reach.push(globRoot(ti.glob, cwd))
    const out = reach.find((r) => !ownFile(r))
    if (out !== undefined) block(`Blocked: you're the orchestrator — you read only your own files (the data home, the plugin, the temp dir, your spilled tool results, a worker's JEEVES_REPORT.md), not ${out}. Looking into a repo is an investigator's job. ${DISPATCH}`)
    allow()
  }

  if (tool === 'Edit' || tool === 'Write') {
    const file = ti.file_path
    if (typeof file !== 'string' || !file) block(`Blocked: ${tool} needs a file_path.`)
    const rel = inside(home, file)
    if (rel === null) block(`Blocked: you're the orchestrator — you never edit files outside the data home (${file}). ${DISPATCH}`)
    const parts = ledgerOf(rel)
    if (!parts) allow()
    const which = parts.length === 1 ? `{ file: "reminders", markdown }` : `{ project: "${parts[1]}", markdown }`
    block(`Blocked: under the cockpit, ${rel} is written with mcp__cockpit__write_state(${which}), the whole file, never Edit/Write, so state diffs stay out of the user's terminal. Resend it through write_state (load it with ToolSearch if it's deferred).`)
  }

  if (tool === 'Skill') {
    const name = String(ti.skill || '').replace(/^\//, '').trim().split(/\s+/)[0]
    if (name === 'loop') allow()
    if (name === 'jeeves:setup') block(`Blocked: /jeeves:setup runs in a tab of its own, never in the orchestrator — open it with mcp__cockpit__add_tab({ space: "scratch", prompt: "/jeeves:setup --scan" }) (or the arguments the user gave).`)
    block(`Blocked: the orchestrator runs no skill but \`loop\` — ${name || 'this one'} belongs to a worker (a review command to the reviewer, posting a review to the reviewer that wrote it). ${DISPATCH}`)
  }

  if (tool === 'Bash') block(`Blocked: under the cockpit the orchestrator has no shell. Status reads go through mcp__cockpit__github_read, github_write, now, open_url and read_spill; anything else is work. ${DISPATCH}`)
  if (tool === 'Agent' || tool === 'Task') block(`Blocked: under the cockpit, agents run through mcp__cockpit__dispatch, never the ${tool} tool — a subagent here has no worktree, no report() and no dashboard row. ${DISPATCH}`)
  if (tool === 'AskUserQuestion') block('Blocked: the orchestrator never waits on a question — raise it under NEEDS YOU in the tick report and carry on.')
  block(`Blocked: the orchestrator doesn't use ${tool} — it reads status and keeps its own files; the work is a dispatched agent's. ${DISPATCH}`)
}
try { main() } catch (e) { refuse(`the guard failed (${e?.message || e})`) }
