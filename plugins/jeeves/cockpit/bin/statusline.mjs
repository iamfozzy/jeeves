#!/usr/bin/env node
// Claude Code status line (Tokyo Night palette), two lines:
//   dir:branch · model / effort
//   ctx % · 5h % (time to reset) · 7d % (time to reset)
// Claude Code pipes the session's status JSON on stdin and shows what this prints.
//
//   statusline.mjs            print the status line (the installed status line)
//   statusline.mjs --relay    for sessions the cockpit launches: report the rate limits to
//                             the cockpit ($JEEVES_USAGE_URL), then print the user's own
//                             status line (the statusLine in ~/.claude/settings.json), or
//                             this one when that's unset, is this script, or prints nothing,
//                             fails or runs past USER_TIMEOUT_MS
// Never fails: a status line must not break its session.
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// A TTY never sends the JSON Claude Code pipes in, so reading it would just
// block forever waiting for input (or Ctrl-D) that's never coming.
const readStdin = () => { if (process.stdin.isTTY) return ''; try { return readFileSync(0, 'utf8') } catch { return '' } }
const raw = readStdin()
let j = {}
try { j = JSON.parse(raw) } catch {}
const get = (path) => path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), j)
const relay = process.argv.includes('--relay')

// Report the rate limits (and context) to the cockpit; never wait long.
function report() {
  const url = process.env.JEEVES_USAGE_URL
  if (!url || !j.rate_limits) return Promise.resolve()
  return new Promise((done) => {
    try {
      const u = new URL(url)
      const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 800 },
        (res) => { res.resume(); res.on('end', done) })
      req.on('error', done); req.on('timeout', () => { try { req.destroy() } catch {} done() })
      req.end(JSON.stringify({ rate_limits: j.rate_limits, context_window: j.context_window }))
    } catch { done() }
  })
}

// The user's own status line command, unless it's this script (or none).
function userCommand() {
  if (process.env.JEEVES_STATUSLINE_CHAINED) return null
  try {
    const cmd = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')).statusLine?.command
    return typeof cmd === 'string' && cmd.trim() && !/statusline\.mjs/.test(cmd) ? cmd : null
  } catch { return null }
}

// Kill the whole tree spawned for the user's command, not just its immediate process:
// on POSIX that's the detached process group (negative pid); spawn() can't detach on
// Windows, so a plain kill() would only take out the shell and leave its children
// running — `taskkill /T` walks the tree by pid instead.
export function killTree(win, pid) {
  try { win ? execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) : process.kill(-pid, 'SIGKILL') } catch {}
}

// Run the user's status line on the same input: its output, or null when it prints nothing,
// exits non-zero or outlasts USER_TIMEOUT_MS (then its whole process group is killed).
const USER_TIMEOUT_MS = 1500
function runUser(cmd) {
  return new Promise((done) => {
    const win = process.platform === 'win32'
    let out = '', settled = false, p, timer
    const finish = (ok) => { if (settled) return; settled = true; clearTimeout(timer); done(ok && out.trim() ? out : null) }
    try { p = spawn(cmd, { shell: true, detached: !win, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, JEEVES_STATUSLINE_CHAINED: '1' } }) } catch { return done(null) }
    timer = setTimeout(() => { killTree(win, p.pid); finish(false) }, USER_TIMEOUT_MS)
    p.stdout.on('data', (d) => { out += d })
    p.on('error', () => finish(false))
    p.on('close', (code) => finish(code === 0))
    p.stdin.on('error', () => {})
    p.stdin.end(raw)
  })
}

const sgr = (style, text) => (style ? `\x1b[${style}m${text}\x1b[0m` : text)
const pct = (path) => { const v = Number(get(path)); return Number.isFinite(v) ? Math.round(v) : 0 }
// Time until a unix-epoch field, as "2h14m" / "3d4h"; empty when absent or past.
function until(path) {
  const at = Number(get(path)); if (!Number.isFinite(at)) return ''
  const d = Math.floor(at - Date.now() / 1000); if (d <= 0) return ''
  const h = Math.floor(d / 3600), m = Math.floor((d % 3600) / 60)
  return h >= 24 ? `${Math.floor(h / 24)}d${h % 24}h` : `${h}h${String(m).padStart(2, '0')}m`
}
function branch() {
  const cwd = get('workspace.current_dir') || get('cwd')
  if (cwd) { try { return execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 }).trim() } catch {} }
  return get('workspace.git_worktree') || ''
}

function render() {
  const dim = '2;38;2;192;202;245', green = '38;2;158;206;106', blue = '38;2;122;162;247'
  const dir = basename(String(get('workspace.current_dir') || ''))
  let l1 = sgr('38;2;187;154;247;49', dir) + sgr('38;2;224;175;104;49', ':') + sgr('38;2;224;175;104;49', branch())
    + sgr(dim, ' · ') + sgr('1;38;2;255;158;100;49', String(get('model.display_name') || '')) + sgr(dim, ' / ')
  if (get('thinking.enabled') === true) l1 += sgr(dim, String(get('effort.level') || ''))
  const limit = (label, key) => {
    const t = until(`rate_limits.${key}.resets_at`)
    return sgr(green, `${label} ${pct(`rate_limits.${key}.used_percentage`)}%`) + (t ? sgr(dim, ` (${t})`) : '')
  }
  const l2 = sgr(blue, `ctx ${pct('context_window.used_percentage')}%`) + sgr(dim, ' · ') + limit('5h', 'five_hour') + sgr(dim, ' · ') + limit('7d', 'seven_day')
  return l1 + '\n' + l2
}

// Guarded so killTree (above) can be imported for a unit test without also running
// the CLI's own stdin-to-stdout pass.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (relay) await report()
    const cmd = relay ? userCommand() : null
    process.stdout.write((cmd && await runUser(cmd)) || render())
  } catch {}
  process.exit(0)
}
