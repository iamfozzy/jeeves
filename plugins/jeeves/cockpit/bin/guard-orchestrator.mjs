#!/usr/bin/env node
// PreToolUse hook for the orchestrator, which dispatches work and never does it.
//   guard-orchestrator.mjs <data-home> <plugin-root>
//  - Edit/Write outside the data home (and the temp dir) is refused: code changes
//    belong to a dispatched story-worker, investigation to an investigator.
//  - The data home's ledgers (projects/*/state.md, reminders.md) are written through
//    the cockpit's write_state tool, so state diffs never fill the user's terminal.
//  - Read/Grep/Glob reach only its own files: the data home, the plugin, the temp
//    dir, and a worker's JEEVES_REPORT.md.
//  - Bash runs only an allowlist: GitHub/Jira metadata and the PR writes the loop
//    posts, the review policy's git fetch/log, and reads of its own files.
//  - Agent/Task is refused: every agent run goes through the cockpit's dispatch.
// Exit 2 refuses the call and hands the reason to the session. Input it can't read
// exits 0; a Bash command it can't parse is refused, since Bash is an allowlist.
import { appendFileSync, existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

const [, , home, pluginRoot] = process.argv
if (!home) process.exit(0)

// Claude Code writes the hook input (JSON with tool_name, tool_input, cwd) to stdin; never wait long.
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

let input
try { input = JSON.parse(await readStdin()) } catch { process.exit(0) }
const tool = input?.tool_name, ti = input?.tool_input || {}, cwd = input?.cwd || home
// Each refusal is logged to <data-home>/guard.log (one JSON line; trimmed to its last
// 500 lines past 256 KB) so Settings can show what the orchestrator was stopped from.
const LOG = join(home, 'guard.log')
function logBlock(why) {
  try {
    const what = String(ti.command ?? ti.file_path ?? ti.notebook_path ?? ti.path ?? ti.pattern ?? ti.subagent_type ?? '').slice(0, 300)
    appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), tool, what, why: why.replace(/^Blocked: /, '').split(' Dispatch it instead')[0].slice(0, 240) }) + '\n')
    if (statSync(LOG).size > 256 * 1024) writeFileSync(LOG, readFileSync(LOG, 'utf8').trimEnd().split('\n').slice(-500).join('\n') + '\n')
  } catch {}
}
const block = (why) => { logBlock(why); process.stderr.write(why + '\n'); process.exit(2) }
const DISPATCH = 'Dispatch it instead: mcp__cockpit__dispatch with agent "story-worker" to change code, "investigator" to look into something, "loop-verifier" to check a result.'

const ci = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s
// A path that doesn't exist yet (a file about to be written) resolves through its
// nearest existing ancestor, so /tmp/new.md and a realpath'd /private/tmp still match.
const real = (p) => { try { return realpathSync(p) } catch { const up = dirname(p); return up === p ? normalize(p) : join(real(up), basename(p)) } }
const expand = (p) => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p)
// The path of p inside root, or null when it's outside. Relative paths resolve
// against base: the session's cwd, or a Bash command's current cd.
let base = cwd
const inside = (root, p) => {
  if (!root) return null
  const r = relative(real(root), real(resolve(base, expand(p))))
  return r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r) ? r : null
}
const temp = (p) => inside(tmpdir(), p) !== null || inside('/tmp', p) !== null || p === '/dev/null'
const ownFile = (p) => inside(home, p) !== null || inside(pluginRoot, p) !== null || temp(p) || basename(p) === 'JEEVES_REPORT.md'

// ── Bash ─────────────────────────────────────────────────────────────────────
// Split a command line into simple commands (on unquoted ; & | && || and newlines),
// honouring quotes, $(…) and `…` (whose contents are checked as commands too) and
// heredoc bodies (data, not commands). Each command is its words (quotes removed),
// the files it redirects output to, and the files it reads from.
function parse(src) {
  const cmds = [], nested = []
  let words = [], word = '', inWord = false, outs = [], ins = [], redir = null, heredocs = []
  const endWord = () => {
    if (!inWord) return
    if (redir) { (redir === '<' ? ins : outs).push(word); redir = null } else words.push(word)
    word = ''; inWord = false
  }
  const endCmd = () => { endWord(); if (words.length || outs.length || ins.length) cmds.push({ words, outs, ins }); words = []; outs = []; ins = [] }
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === "'") { const j = src.indexOf("'", i + 1); if (j < 0) return null; word += src.slice(i + 1, j); inWord = true; i = j + 1; continue }
    if (c === '"') {
      let j = i + 1
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === '\\') { word += src[++j] ?? ''; continue }
        if (src[j] === '$' && src[j + 1] === '(') { const k = close(src, j + 1); if (k < 0) return null; nested.push(src.slice(j + 2, k)); word += 'X'; j = k; continue }
        if (src[j] === '`') { const k = src.indexOf('`', j + 1); if (k < 0) return null; nested.push(src.slice(j + 1, k)); word += 'X'; j = k; continue }
        word += src[j]
      }
      if (j >= src.length) return null
      inWord = true; i = j + 1; continue
    }
    if (c === '\\' && src[i + 1] === '\n') { i += 2; continue } // line continuation
    if (c === '\\') { word += src[i + 1] ?? ''; inWord = true; i += 2; continue }
    if (c === '$' && src[i + 1] === '(') { const k = close(src, i + 1); if (k < 0) return null; nested.push(src.slice(i + 2, k)); word += 'X'; inWord = true; i = k + 1; continue }
    if (c === '`') { const k = src.indexOf('`', i + 1); if (k < 0) return null; nested.push(src.slice(i + 1, k)); word += 'X'; inWord = true; i = k + 1; continue }
    if (c === '#' && !inWord) { const j = src.indexOf('\n', i); i = j < 0 ? src.length : j; continue }
    if (c === '\n') {
      endCmd(); i++
      for (const tag of heredocs) { // skip each pending heredoc body
        while (i < src.length) { const j = src.indexOf('\n', i), line = src.slice(i, j < 0 ? src.length : j); i = j < 0 ? src.length : j + 1; if (line.trim() === tag) break }
      }
      heredocs = []; continue
    }
    if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')' || c === '{' && !inWord || c === '}' && !inWord) {
      if (c === '&' && src[i - 1] === '>') { i++; continue } // part of >&
      endCmd(); i++; continue
    }
    if (c === '<' && src[i + 1] === '<') { // heredoc: record its end tag
      endWord(); let j = i + 2; if (src[j] === '-') j++
      while (src[j] === ' ') j++
      const m = src.slice(j).match(/^(['"]?)([A-Za-z_][\w-]*)\1/); if (!m) return null
      heredocs.push(m[2]); i = j + m[0].length; continue
    }
    if (c === '>' || c === '<') {
      endWord()
      if (/^[0-9]$/.test(words[words.length - 1] ?? '') && src[i - 1] === words[words.length - 1]) words.pop() // the fd in 2>
      if (src[i + 1] === '&') { i += 2; while (/[0-9-]/.test(src[i] ?? '')) i++; continue } // >&1, 2>&1
      redir = c; i += src[i + 1] === '>' ? 2 : 1; continue
    }
    if (c === ' ' || c === '\t') { endWord(); i++; continue }
    word += c; inWord = true; i++
  }
  endCmd()
  if (redir) return null
  for (const n of nested) { const p = parse(n); if (!p) return null; cmds.push(...p) }
  return cmds
}
// Index of the ) closing the ( at src[open], skipping quoted text; -1 if none.
function close(src, open) {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === "'") { const j = src.indexOf("'", i + 1); if (j < 0) return -1; i = j; continue }
    if (c === '"') { let j = i + 1; while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1; i = j; continue }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return -1
}

// Read-only helpers: fine on the orchestrator's own files, and with no file at all.
const READERS = new Set(['cat', 'head', 'tail', 'grep', 'egrep', 'awk', 'sed', 'wc', 'sort', 'uniq', 'cut', 'tr', 'jq', 'diff'])
// Listing isn't reading code (setup's --scan lists the dev root), so these go anywhere.
const LISTERS = new Set(['ls', 'stat', 'file', 'basename', 'dirname', 'realpath', 'readlink', 'find'])
// Shell keywords that lead or close a command; what follows them is checked as usual.
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'while', 'until', 'do', 'done', '!', 'time', 'esac'])
const INTERPRETERS = new Set(['python', 'python3', 'node', 'perl', 'ruby', 'bash', 'sh', 'zsh', 'osascript', 'deno', 'bun'])
const PROGRAM_FIRST = new Set(['grep', 'egrep', 'awk', 'sed', 'jq'])
const HARMLESS = new Set(['date', 'echo', 'printf', 'true', 'false', 'test', '[', 'pwd', 'cd', 'sleep', 'which', 'command', 'type', 'env', 'export', 'set', 'read'])
const GH = { api: true, search: true, auth: ['status'], repo: ['view', 'list'], pr: ['view', 'checks', 'list', 'status', 'review', 'comment', 'edit'], run: ['list'], issue: ['view', 'list'] }
const GIT = new Set(['fetch', 'log', 'rev-parse', 'remote', 'show-ref', 'ls-remote', 'merge-base', 'rev-list', 'branch', 'worktree', 'status', 'config'])
const OPENERS = new Set(['open', 'xdg-open', 'start'])

function checkBash(src) {
  const cmds = parse(src)
  if (!cmds) block(`Blocked: couldn't parse that command, and the orchestrator's Bash is an allowlist. Keep to metadata calls (gh api / gh pr view / gh pr checks, git fetch / git log) and reads of your own files. ${DISPATCH}`)
  for (const { words, outs, ins } of cmds) {
    for (const o of outs) if (!temp(o)) block(`Blocked: you're the orchestrator — Bash never writes files (> ${o}). Ledgers go through write_state; anything else is a worker's job. ${DISPATCH}`)
    for (const f of ins) if (!ownFile(f)) block(`Blocked: you read only your own files, not ${f}. ${DISPATCH}`)
    let s = 0
    while (s < words.length && (/^\w+=/.test(words[s]) || KEYWORDS.has(words[s]))) s++ // VAR=value, do/then/…
    const w = words.slice(s), cmd = w[0]
    if (!cmd) continue
    if (cmd === 'for' || cmd === 'case') continue // `for x in …` / `case … in`: the words are data
    if (cmd === 'cd') { if (w[1] && w[1] !== '-') base = resolve(base, expand(w[1])); continue }
    const why = allowed(cmd, w.slice(1))
    if (why !== true) block(`Blocked: the orchestrator doesn't run \`${[cmd, ...w.slice(1, 3)].join(' ')}\` — ${why}. ${DISPATCH}`)
  }
  process.exit(0)
}

function allowed(cmd, args) {
  const name = basename(cmd)
  if (HARMLESS.has(name)) return true
  if (INTERPRETERS.has(name)) return `an interpreter can run anything; filter gh output with --jq or jq instead`
  if (LISTERS.has(name)) return name !== 'find' || !args.some((a) => /^-(exec|execdir|delete|ok|okdir|fprint)/.test(a)) || 'it changes files'
  if (OPENERS.has(name)) return args.every((a) => /^https?:\/\//.test(a) || a.startsWith('-')) || 'it opens only URLs'
  if (name === 'gh') {
    const sub = args.find((a) => !a.startsWith('-')), rule = GH[sub]
    if (!rule) return `gh ${sub ?? ''} isn't a metadata call or a PR write the loop posts`
    if (rule === true) return true
    const verb = args.slice(args.indexOf(sub) + 1).find((a) => !a.startsWith('-'))
    return rule.includes(verb) || `gh ${sub} ${verb ?? ''} isn't a metadata call or a PR write the loop posts`
  }
  if (name === 'git') {
    let k = 0
    while (k < args.length && args[k].startsWith('-')) k += args[k] === '-C' || args[k] === '-c' ? 2 : 1
    const sub = args[k]
    if (!GIT.has(sub)) return `git ${sub ?? ''} changes or inspects a repo's code — that's a worker's or investigator's job`
    const rest = args.slice(k + 1)
    if (sub === 'worktree' && rest[0] !== 'list') return 'managing worktrees is the cockpit\'s job (dispatch creates them, close_work removes them)'
    if (sub === 'branch' && rest.some((a) => /^-[dDmMcC]$|^--(delete|move|copy)/.test(a))) return 'it changes branches'
    if (sub === 'remote' && rest.some((a) => /^(add|remove|rm|rename|set-url|set-head|prune)$/.test(a))) return 'it changes remotes'
    if (sub === 'config' && !rest.some((a) => /^--(get|list|get-all|get-regexp)$|^-l$/.test(a))) return 'it only reads config'
    if (sub === 'log' && rest.some((a) => /^(-p|--patch|-u|--stat|--numstat|--name-only|--name-status)$/.test(a))) return 'reading a diff is an investigator\'s job'
    return true
  }
  if (READERS.has(name)) {
    if (name === 'sed' && args.some((a) => /^-i|^--in-place/.test(a))) return 'it edits files'
    if (name === 'awk' && args.some((a) => /inplace/.test(a))) return 'it edits files'
    // A pattern or program comes first (grep/awk/sed/jq), unless -e/-f supplies it.
    let operands = args.filter((a) => !a.startsWith('-'))
    if (PROGRAM_FIRST.has(name) && !args.some((a) => /^-[ef]$|^--(regexp|file|expression)/.test(a))) operands = operands.slice(1)
    const paths = operands.filter((a) => a.includes('/') || a.startsWith('~') || /\.\w{1,5}$/.test(a) || existsSync(resolve(cwd, a)))
    const outside = paths.find((a) => !ownFile(a.replace(/[*?[].*$/, '') || '.'))
    return outside === undefined || `it reads ${outside}, outside your own files — looking into a repo is an investigator's job`
  }
  return `\`${name}\` isn't on the orchestrator's allowlist (metadata calls and reads of its own files)`
}

// Runs last, once the allowlists above exist.
function main() {
  if (tool === 'Agent' || tool === 'Task') block(`Blocked: under the cockpit, agents run through mcp__cockpit__dispatch, never the ${tool} tool — a subagent here has no worktree, no report() and no dashboard row. ${DISPATCH}`)

  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') {
    const p = ti.file_path ?? ti.path ?? cwd
    if (typeof p === 'string' && !ownFile(p)) block(`Blocked: you're the orchestrator — you read only your own files (the data home, the plugin, a worker's JEEVES_REPORT.md), not ${p}. Looking into a repo is an investigator's job. ${DISPATCH}`)
    process.exit(0)
  }

  if (tool === 'Bash') checkBash(String(ti.command || ''))

  const file = ti.file_path ?? ti.notebook_path
  if (typeof file !== 'string' || !file) process.exit(0)
  const rel = inside(home, file)
  if (rel === null) {
    if (temp(file)) process.exit(0)
    block(`Blocked: you're the orchestrator — you never edit files outside the data home (${file}). ${DISPATCH}`)
  }
  const parts = rel.split(sep)
  const ledger = (parts.length === 1 && ci(parts[0]) === 'reminders.md')
    || (parts.length === 3 && ci(parts[0]) === 'projects' && ci(parts[2]) === 'state.md')
  if (!ledger) process.exit(0)
  const which = parts.length === 1 ? `{ file: "reminders", markdown }` : `{ project: "${parts[1]}", markdown }`
  block(`Blocked: under the cockpit, ${rel} is written with mcp__cockpit__write_state(${which}), the whole file, never Edit/Write, so state diffs stay out of the user's terminal. Resend it through write_state (load it with ToolSearch if it's deferred).`)
}
main()
