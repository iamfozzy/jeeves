import http from 'node:http'
import os from 'node:os'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync, copyFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname, normalize, basename, sep } from 'node:path'
import { createRequire } from 'node:module'
import { execFile, execFileSync } from 'node:child_process'
import { randomBytes, timingSafeEqual, randomUUID, createHash } from 'node:crypto'
import { openSync, fstatSync, readSync, closeSync, writeFileSync, appendFileSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

// node-pty is a native CommonJS addon; load it through require so ESM interop
// never trips on the prebuilt binary.
const require = createRequire(import.meta.url)
const pty = require('node-pty')

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 4177
const HOST = process.env.HOST || '127.0.0.1' // loopback only — never LAN-exposed
const WIN = process.platform === 'win32'
const SHELL = process.env.SHELL || (WIN ? 'powershell.exe' : 'bash')
// The orchestrator's neutral home = the Jeeves data home (matches bin/jeeves and
// discoverRepos). NOT $HOME — that would run the loop in the wrong dir and, since
// the cwd allowlist includes NEUTRAL, would allow the entire home tree as a cwd.
const NEUTRAL = process.env.JEEVES_HOME || join(os.homedir(), 'jeeves')
const DIST = join(__dirname, 'dist')

// ── Local access token ───────────────────────────────────────────────────────
// The server is loopback-only, but a token still blocks any other local process
// (or a browser tricked into POSTing to localhost) from driving PTYs. Taken from
// $JEEVES_TOKEN, else persisted to .jeeves-token so restarts keep the same value
// and an open browser tab stays valid. Settings → Cockpit can rotate the persisted
// one. Sessions this process spawns (MCP config, lifecycle hooks) authenticate with
// SESSION_TOKEN instead — per boot, never shown — so a rotation never cuts off the
// running orchestrator or workers.
const TOKEN_FILE = join(__dirname, '.jeeves-token')
let TOKEN = (() => {
  if (process.env.JEEVES_TOKEN) return process.env.JEEVES_TOKEN
  try { const t = readFileSync(TOKEN_FILE, 'utf8').trim(); if (t) return t } catch {}
  const t = randomBytes(24).toString('hex')
  writeFile(TOKEN_FILE, t).catch(() => {})
  return t
})()
const SESSION_TOKEN = randomBytes(24).toString('hex')
const cockpitUrl = () => `http://localhost:${PORT}/?token=${TOKEN}`
function tokenOk(provided) {
  if (!provided) return false
  const a = Buffer.from(String(provided))
  return [TOKEN, SESSION_TOKEN].some((t) => { const b = Buffer.from(t); return a.length === b.length && timingSafeEqual(a, b) })
}
function authed(req, url) {
  const h = req.headers['authorization'] || ''
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : null
  return tokenOk(bearer || url.searchParams.get('token'))
}
// A fresh browser token, persisted to .jeeves-token; the old one stops working at once.
async function rotateToken() {
  if (process.env.JEEVES_TOKEN) return { error: 'the token is pinned by $JEEVES_TOKEN' }
  const t = randomBytes(24).toString('hex')
  try { await writeFile(TOKEN_FILE, t) } catch (e) { return { error: 'write failed: ' + e.message } }
  TOKEN = t
  return { token: t }
}

// ── Cockpit settings: <data-home>/cockpit.json ───────────────────────────────
// Models, permission modes and session hygiene for what this process spawns, and
// the UI's appearance (fonts), which /api/config hands every browser at boot.
// An env var, when set, wins over the file (the UI shows it pinned). Read at boot
// and after every Settings save; each spawn reads the live value.
const MODELS = ['claude-sonnet-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-haiku-4-5', 'claude-fable-5-1']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const PERMISSION_MODES = ['auto', 'manual', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'] // `claude --permission-mode` choices
const COCKPIT_SPEC = {
  orchModel: { env: 'JEEVES_ORCH_MODEL', dflt: 'claude-sonnet-5', choices: MODELS },
  orchEffort: { env: 'JEEVES_ORCH_EFFORT', dflt: 'medium', choices: EFFORTS },
  workerModel: { env: 'JEEVES_WORKER_MODEL', dflt: 'claude-opus-5-5', choices: MODELS },
  // Keep both modes the same: cross-session worker → orchestrator messages
  // auto-deliver only between sessions in the same mode.
  orchPermission: { env: 'JEEVES_ORCH_PERMISSION', dflt: 'auto', choices: PERMISSION_MODES },
  workerPermission: { env: 'JEEVES_WORKER_PERMISSION', dflt: 'auto', choices: PERMISSION_MODES },
  rotatePct: { env: 'JEEVES_ORCH_ROTATE_PCT', dflt: 70, range: [1, 100] },   // Restart button lights at/above this
  compactPct: { env: 'JEEVES_ORCH_COMPACT_PCT', dflt: 40, range: [0, 100] }, // auto-/compact an idle orchestrator at/above this; 0 = never
  detachMinutes: { dflt: 30, range: [0, 10080] },                           // reap a detached user tab after this; 0 = never
  uiFont: { env: 'JEEVES_UI_FONT', dflt: 'Roboto', font: true },       // a Google Font family, or `system`
  monoFont: { env: 'JEEVES_MONO_FONT', dflt: 'Roboto Mono', font: true },
  terminalFontSize: { env: 'JEEVES_TERMINAL_FONT_SIZE', dflt: 13, range: [10, 20] }
}
const FONT_NAME = /^[A-Za-z0-9 -]{1,60}$/ // a Google Font family name; the browser builds the stylesheet URL from it
const COCKPIT_FILE = join(NEUTRAL, 'cockpit.json')
// A submitted value as cockpit.json stores it, or { error }. Numbers may arrive as digit strings.
function cockpitValue(key, v) {
  const s = COCKPIT_SPEC[key]
  if (!s) return { error: 'unknown setting: ' + key }
  if (s.range) {
    const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? +v : v
    return Number.isInteger(n) && n >= s.range[0] && n <= s.range[1] ? { value: n } : { error: `${key} must be a whole number ${s.range[0]}–${s.range[1]}` }
  }
  if (s.font) {
    const f = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : ''
    return FONT_NAME.test(f) ? { value: f } : { error: `${key} must be a Google Font family name (letters, digits, spaces, -; up to 60) or system` }
  }
  return s.choices.includes(v) ? { value: v } : { error: `${key} must be one of ${s.choices.join(', ')}` }
}
let cockpitFile = {}
function loadCockpit() {
  let raw = {}
  try { raw = JSON.parse(readFileSync(COCKPIT_FILE, 'utf8')) } catch {}
  cockpitFile = {}
  for (const [k, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    const c = cockpitValue(k, v)
    if (c.error) console.warn(`cockpit.json: ignoring ${k} (${c.error})`); else cockpitFile[k] = c.value
  }
}
loadCockpit()
const pinnedBy = (key) => { const e = COCKPIT_SPEC[key].env; return e && process.env[e] ? e : null }
// A pinned model or mode is taken as given. A pinned number or font that fails
// validation is ignored (warned at boot), so the file or default applies.
const envValue = (key) => {
  const e = pinnedBy(key)
  if (!e) return null
  if (COCKPIT_SPEC[key].choices) return { value: process.env[e] }
  return cockpitValue(key, process.env[e])
}
for (const k of Object.keys(COCKPIT_SPEC)) { const c = envValue(k); if (c?.error) console.warn(`$${pinnedBy(k)}: ignoring (${c.error})`) }
// A key is pinned only while its env var holds a valid value; an invalid one is ignored
// everywhere, so the UI leaves the field editable and saves go through.
const pinnedValid = (key) => { const c = envValue(key); return c && !c.error ? pinnedBy(key) : null }
function cfg(key) {
  const c = envValue(key)
  if (c && !c.error) return c.value
  return cockpitFile[key] ?? COCKPIT_SPEC[key].dflt
}
const appearance = () => ({ uiFont: cfg('uiFont'), monoFont: cfg('monoFont'), terminalFontSize: cfg('terminalFontSize') })
function cockpitView() {
  const keys = Object.keys(COCKPIT_SPEC)
  return {
    values: Object.fromEntries(keys.map((k) => [k, cfg(k)])),
    defaults: Object.fromEntries(keys.map((k) => [k, COCKPIT_SPEC[k].dflt])),
    pinned: Object.fromEntries(keys.map((k) => [k, pinnedValid(k)]).filter(([, e]) => e)),
    choices: { models: MODELS, efforts: EFFORTS, permissionModes: PERMISSION_MODES }
  }
}
// Apply { set: {key: value}, unset: [key] } to cockpit.json; unset = back to the default.
async function writeCockpit({ set = {}, unset = [] } = {}) {
  if (typeof set !== 'object' || set === null || Array.isArray(set) || !Array.isArray(unset)) return { error: 'set must be an object, unset an array' }
  const next = { ...cockpitFile }
  for (const k of unset) { if (!COCKPIT_SPEC[k]) return { error: 'unknown setting: ' + k }; delete next[k] }
  for (const [k, v] of Object.entries(set)) {
    const c = cockpitValue(k, v)
    if (c.error) return c
    if (pinnedValid(k)) return { error: `${k} is pinned by $${pinnedValid(k)}` }
    next[k] = c.value
  }
  try { await writeFile(COCKPIT_FILE, JSON.stringify(next, null, 2) + '\n') } catch (e) { return { error: 'write failed: ' + e.message } }
  loadCockpit()
  lastContext = { ...lastContext, rotateAt: cfg('rotatePct') }
  pushContext()
  pushConfig() // every open tab refetches /api/config, which carries the appearance
  return { ok: true }
}

// ── Control plane (MCP bus) ──────────────────────────────────────────────────
// The orchestrator paints the dashboard and dispatches work through an MCP
// server hosted in this same process (so it shares the PTY registry + browser
// push). We spawn the orchestrator with a session id we choose, so we know
// exactly which transcript to read for its context usage.
// Persisted, so a server restart resumes the same conversation; follows /clear via
// the SessionStart hook.
const ORCH_SESSION_FILE = join(__dirname, '.jeeves-orch-session')
let ORCH_SESSION_ID = process.env.JEEVES_ORCH_SESSION_ID || (() => {
  try { const id = readFileSync(ORCH_SESSION_FILE, 'utf8').trim(); if (/^[0-9a-f-]{36}$/i.test(id)) return id } catch {}
  return randomUUID()
})()
function setOrchSessionId(id) { ORCH_SESSION_ID = id; try { writeFileSync(ORCH_SESSION_FILE, id) } catch {} }
setOrchSessionId(ORCH_SESSION_ID)
// Pin every "opus" the loop asks for — the bare `opus` alias or any versioned opus
// id — to the configured worker Opus (Opus 5.5 unless the worker model is set to
// another Opus), so an alias never resolves to an older Opus. Sonnet/Haiku and any
// non-opus id pass through untouched.
const OPUS_RE = /^(claude-)?opus(-\d+)*$/i
const workerOpus = () => (OPUS_RE.test(cfg('workerModel')) ? cfg('workerModel') : 'claude-opus-5-5')
const pinOpus = (m) => OPUS_RE.test(String(m)) ? workerOpus() : String(m)
// A stable name so workers can message the orchestrator cross-session.
const ORCH_NAME = process.env.JEEVES_ORCH_NAME || 'jeeves-orchestrator'
const CTX_WINDOW = +(process.env.JEEVES_CTX_WINDOW || 1000000) // orchestrator context window for the ctx% badge (default 1M)
// MCP configs. The orchestrator's is a file with the full tool set. Workers and
// claude tabs get theirs inline, carrying their own sid so the server knows which
// session is calling: /mcp?role=worker (report + the child-tab tools) or
// /mcp?role=tab (the child-tab tools only).
const MCP_CONFIG_FILE = join(__dirname, '.jeeves-mcp.json')
const mcpConfig = (role, caller) => JSON.stringify({
  mcpServers: { cockpit: { type: 'http', url: `http://${HOST}:${PORT}/mcp${role ? `?role=${role}&sid=${encodeURIComponent(caller)}` : ''}`, headers: { Authorization: `Bearer ${SESSION_TOKEN}` } } }
})
try { writeFileSync(MCP_CONFIG_FILE, JSON.stringify(JSON.parse(mcpConfig()), null, 2)) } catch {}

// Bus state: the last surface the orchestrator painted and the dispatched worker
// spaces (the durable store — each worker's report lives on its record). `inbox`
// is only a best-effort fallback for orphan reports whose worker record is gone.
const bus = { surface: null, workers: new Map(), inbox: [] }
const workerList = () => [...bus.workers.values()]

// ── Session persistence (survive a server restart) ───────────────────────────
// PTYs are children of this process, so they die when it does. Rather than keep
// them alive (a tmux/dtach broker), we persist enough to RESPAWN + RESUME on the
// next attach: the orchestrator already resumes; workers and user claude tabs get
// a stable session id here so `claude --resume` restores their conversation.
// Shell/codex tabs have nothing to resume — they respawn fresh.
const WORKERS_FILE = join(__dirname, '.jeeves-workers.json')
const TABS_FILE = join(__dirname, '.jeeves-tabs.json')
function saveWorkers() { try { writeFileSync(WORKERS_FILE, JSON.stringify(workerList())) } catch {} }
// tab sid ("space:tab") → { sessionId, cwd }, so a claude tab resumes after a restart.
const tabSessions = new Map()
function saveTabs() { try { writeFileSync(TABS_FILE, JSON.stringify([...tabSessions])) } catch {} }
// The user's layout — open spaces and their tabs, the Scratchpad, pinned and recent
// repos. The server owns it, not the browser, so every origin that serves the UI
// (vite in dev, the built bundle here) shows the same spaces.
const LAYOUT_FILE = join(__dirname, '.jeeves-layout.json')
let layout = null
function saveLayout(next) { layout = next; try { writeFileSync(LAYOUT_FILE, JSON.stringify(next)) } catch {} }

// The transcript JSONL claude writes for a session run in `cwd` — its existence
// is how we tell "resume this" from "start fresh".
function transcriptPathFor(cwd, sessionId) {
  const enc = normalize(cwd).replace(/[^A-Za-z0-9]/g, '-')
  return join(os.homedir(), '.claude', 'projects', enc, sessionId + '.jsonl')
}

// A folder inside a worktree that never dirties it: created with a `*` .gitignore.
function ignoredDir(dir) {
  mkdirSync(dir, { recursive: true })
  if (!existsSync(join(dir, '.gitignore'))) writeFileSync(join(dir, '.gitignore'), '*\n')
  return dir
}

// Browser push channel (/events WebSocket).
const eventClients = new Set()
function broadcast(msg) {
  const s = JSON.stringify(msg)
  for (const ws of eventClients) if (ws.readyState === 1) { try { ws.send(s) } catch {} }
}
const hasBrowser = () => { for (const ws of eventClients) if (ws.readyState === 1) return true; return false }
const pushSurface = () => broadcast({ t: 'surface', payload: bus.surface })
const pushSpaces = () => broadcast({ t: 'spaces', spaces: workerList() })
const pushContext = () => broadcast({ t: 'context', ctx: lastContext })
// Lifecycle status of user-opened claude tabs, keyed by their sid (`spaceId:tabId`).
const sessionStatus = new Map()
// Child tabs a session opened with open_tab, keyed by tabRef — which is also the
// new tab's id, so its sid is `<spaceId>:<tabRef>` and attach can find the pending
// launch. { parent, kind, cwd, prompt, result, sid } — sid is bound on first
// attach. In memory: after a server restart a child is an ordinary tab.
const tabLinks = new Map()
const pushSessionStatus = (sid, status) => broadcast({ t: 'sessionStatus', sid, status })
// Project config changed (created / updated / deleted) — tell the UI to refetch.
const pushConfig = () => broadcast({ t: 'config' })

// Orchestrator context usage, read from its transcript JSONL.
function orchTranscriptPath() {
  const enc = NEUTRAL.replace(/[^A-Za-z0-9]/g, '-')
  return join(os.homedir(), '.claude', 'projects', enc, ORCH_SESSION_ID + '.jsonl')
}
function tailBytes(path, n = 65536) {
  let fd
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const start = Math.max(0, size - n)
    const len = size - start
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, start)
    return buf.toString('utf8')
  } catch { return '' } finally { if (fd !== undefined) try { closeSync(fd) } catch {} }
}
let orchStatus = 'idle' // hook-driven: working | awaiting | idle | exited
let lastContext = { pct: null, used: 0, window: CTX_WINDOW, model: null, sessionId: ORCH_SESSION_ID, rotateAt: cfg('rotatePct'), status: orchStatus, updatedAt: 0 }
function readOrchContext() {
  const tail = tailBytes(orchTranscriptPath())
  if (!tail) return lastContext
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line || line[0] !== '{') continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    const u = o?.message?.usage
    if (!u) continue
    const used = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)
    lastContext = { pct: Math.round((used / CTX_WINDOW) * 100), used, window: CTX_WINDOW, model: o.message.model || null, sessionId: ORCH_SESSION_ID, rotateAt: cfg('rotatePct'), status: orchStatus, updatedAt: Date.now() }
    return lastContext
  }
  return lastContext
}

// ── Repo discovery (from the Jeeves data home) ───────────────────────────────
function expandHome(p) { return p && p.startsWith('~') ? join(os.homedir(), p.slice(1)) : p }

// ── Config files: defaults.md, identity.md, projects/<id>/project.md ─────────
// Two kinds of setting live in them. Frontmatter keys (a leading `---` block of
// flat `key: value` scalars) and bold-label fields (`- **QA columns:** \`QA\``).
// Edits rewrite only the lines of the fields they change; every other byte —
// prose, comments, order, fields this code doesn't know — is kept as-is.
function splitFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { data: {}, body: md }
  const data = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/)
    if (kv) data[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return { data, body: md.slice(m[0].length) }
}
// updates: { key: value }; null or '' removes the key. A block left empty is dropped.
function writeFrontmatter(md, updates) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  const lines = m ? m[1].split(/\r?\n/) : []
  for (const [k, v] of Object.entries(updates)) {
    const i = lines.findIndex((l) => (l.match(/^([A-Za-z0-9_]+):/) || [])[1] === k)
    if (v == null || v === '') { if (i >= 0) lines.splice(i, 1) }
    else if (i >= 0) lines[i] = `${k}: ${v}`
    else lines.push(`${k}: ${v}`)
  }
  const body = m ? md.slice(m[0].length) : md
  if (!lines.some((l) => l.trim())) return m ? body.replace(/^\r?\n+/, '') : md
  return `---\n${lines.join('\n')}\n---\n${m ? '' : '\n'}${body}`
}
const splitList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean)
// Unfilled template placeholders (`<...>`) count as unset.
const real = (v) => (v && !v.includes('<') ? v : null)

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const fieldLineRe = (label) => new RegExp(`^([ \\t]*(?:[-*][ \\t]+)?\\*\\*${reEsc(label)}:\\*\\*[ \\t]*)(.*)$`, 'im')
const ANY_FIELD_LINE = /^[ \t]*(?:[-*][ \t]+)?\*\*[^*\n]+:\*\*/
const CONTINUATION = /^[ \t]+#/ // an indented comment line continuing the field above
// A field line's value region: backticked values (comma-separated for a list) and
// an optional `(parenthetical)`. The tail (alignment, `# comment`) is kept as-is.
function parseRegion(rest) {
  const m = rest.match(/^`[^`\n]*`(?:[ \t]*,[ \t]*`[^`\n]*`)*(?:[ \t]*\(([^)\n]*)\))?/)
  if (m) return { vals: [...m[0].matchAll(/`([^`\n]*)`/g)].map((x) => x[1]), paren: m[1] ?? null, region: m[0], tail: rest.slice(m[0].length) }
  const cut = rest.search(/\s+#/)
  const region = cut < 0 ? rest : rest.slice(0, cut)
  return { vals: region.trim() ? [region.trim()] : [], paren: null, region, tail: rest.slice(region.length) }
}

// A setting: `label` for a bold-label field, `fm` for a frontmatter key. kind is
// 'text', 'list', or 'paren' (the parenthetical on another field's line — the
// Jira site after the cloudId). `section` is where a missing field is inserted.
const F = (key, label, kind = 'text', section = null) => ({ key, label, kind, section })
const FM = (key, kind = 'text') => ({ key, fm: true, kind })
const CONFIG_FIELDS = {
  defaults: [
    F('cloudId', 'cloudId', 'text', 'Jira'), F('jiraSite', 'cloudId', 'paren', 'Jira'),
    F('planTrigger', 'plan trigger', 'text', 'Jira'), F('qaAssigneeField', 'QA-assignee field', 'text', 'Jira'),
    F('qaColumns', 'QA columns', 'list', 'Jira'),
    F('confluenceSpace', 'space', 'text', 'Confluence'), F('plansParent', 'Plans parent', 'text', 'Confluence'),
    F('reviewScope', 'review scope', 'text', 'GitHub'), F('baseBranches', 'base branches', 'list', 'GitHub'),
    FM('reviewCommand'), FM('seedFiles', 'list'),
    // Loop behaviour, read by the loop at launch (BRIEF: Each tick step 6, Daily, Rules → Push).
    F('tickSeconds', 'tick seconds', 'text', 'Loop'), F('tickMidFlightSeconds', 'tick mid-flight seconds', 'text', 'Loop'),
    F('tickOvernightSeconds', 'tick overnight seconds', 'text', 'Loop'), F('overnight', 'overnight', 'text', 'Loop'),
    F('dailySummary', 'daily summary', 'text', 'Loop'), F('dailySummaryAt', 'daily summary at', 'text', 'Loop'),
    F('pushNotifications', 'push notifications', 'text', 'Notifications'), F('notifyReminders', 'notify reminders', 'text', 'Notifications'),
    F('notifyWorkerFinished', 'notify worker finished', 'text', 'Notifications'), F('notifyReviewReady', 'notify review ready', 'text', 'Notifications')
  ],
  identity: [F('ghLogin', 'gh login'), F('jiraEmail', 'Jira email'), F('displayName', 'display name'), F('devRoot', 'dev root')],
  project: [
    F('baseBranch', 'base branch', 'text', 'Identity'), F('jiraKey', 'project key', 'text', 'Jira'),
    F('reviewScope', 'review scope', 'text', 'GitHub'), FM('reviewCommand'), FM('seedFiles', 'list')
  ]
}
const REPO_F = F('repo', 'repo'), PATH_F = F('path', 'path')
const SITE_F = CONFIG_FIELDS.defaults.find((f) => f.key === 'jiraSite')
const ON_OFF = ['on', 'off']
const CHOICES = {
  reviewScope: ['mine', 'repo'], dailySummary: ON_OFF,
  pushNotifications: ON_OFF, notifyReminders: ON_OFF, notifyWorkerFinished: ON_OFF, notifyReviewReady: ON_OFF
}
// Shape checks for free-text values: an error message, or null when the value is fine.
const HHMM = '([01]\\d|2[0-3]):[0-5]\\d'
const seconds = (v) => (/^\d+$/.test(v) && +v >= 30 && +v <= 86400 ? null : 'whole seconds, 30–86400')
const FORMATS = {
  tickSeconds: seconds, tickMidFlightSeconds: seconds, tickOvernightSeconds: seconds,
  overnight: (v) => (new RegExp(`^${HHMM}-${HHMM}$`).test(v) ? null : 'HH:MM-HH:MM, e.g. 22:00-08:00'),
  dailySummaryAt: (v) => (new RegExp(`^${HHMM}$`).test(v) ? null : 'HH:MM, e.g. 09:00')
}

// A setting's value in one file: a string, a string list, or null when absent or a placeholder.
function readField(md, f) {
  if (f.fm) {
    const raw = splitFrontmatter(md).data[f.key]
    if (f.kind === 'list') { const v = splitList(raw).filter(real); return v.length ? v : null }
    return real(raw?.trim())
  }
  const m = md.match(fieldLineRe(f.label))
  if (!m) return null
  const p = parseRegion(m[2])
  if (f.kind === 'paren') return real(p.paren?.trim())
  if (f.kind === 'list') { const v = p.vals.map((s) => s.trim()).filter(real); return v.length ? v : null }
  return real(p.vals[0]?.trim())
}
// The project value wins; otherwise the default; otherwise unset. `default` is
// what the field inherits, so the UI can show and reset to it.
function effectiveField(md, defaultsMd, f) {
  const own = readField(md, f), dflt = readField(defaultsMd, f)
  const source = own != null ? 'project' : dflt != null ? 'default' : 'unset'
  return { value: own ?? dflt, source, default: dflt }
}

// Set (value) or remove (null) a bold-label field in place.
function setMdField(md, f, value) {
  const m = md.match(fieldLineRe(f.label))
  if (!m) {
    if (value == null) return md
    const vals = f.kind === 'paren' ? ['<cloud-id>'] : [value].flat()
    return insertFieldLine(md, f, `- **${f.label}:** ${serializeRegion(vals, f.kind === 'paren' ? value : null)}`)
  }
  const p = parseRegion(m[2])
  let { vals, paren } = p
  if (f.kind === 'paren') paren = value
  else if (value == null) return removeFieldLine(md, m.index)
  else vals = [value].flat()
  const region = serializeRegion(vals, paren)
  const gap = p.tail.match(/^[ \t]*/)[0], comment = p.tail.slice(gap.length)
  // Keep a trailing comment at its column where the new value allows it.
  const tail = comment ? ' '.repeat(Math.max(1, gap.length + p.region.length - region.length)) + comment : p.tail
  return md.slice(0, m.index) + m[1] + region + tail + md.slice(m.index + m[0].length)
}
const serializeRegion = (vals, paren) => vals.map((v) => `\`${v}\``).join(', ') + (paren ? ` (${paren})` : '')
function removeFieldLine(md, at) {
  const lines = md.slice(at).split('\n')
  let n = 1
  while (n < lines.length && CONTINUATION.test(lines[n])) n++
  return md.slice(0, at) + lines.slice(n).join('\n')
}
// A missing field goes after the last field of its `## section`; with no such
// heading, a file that has sections gets a new one at the end, and a flat file
// gets it after its last field.
function insertFieldLine(md, f, line) {
  const lines = md.split('\n')
  const isHeading = (l) => /^#{1,6}\s/.test(l)
  let lo = 0, hi = lines.length
  const h = f.section ? lines.findIndex((l) => new RegExp(`^#{2,6}\\s*${reEsc(f.section)}\\b`, 'i').test(l)) : -1
  if (h >= 0) {
    lo = h + 1
    const next = lines.findIndex((l, i) => i > h && isHeading(l))
    hi = next < 0 ? lines.length : next
  } else if (f.section && lines.some((l) => /^##\s/.test(l))) {
    return md.replace(/\n*$/, '') + `\n\n## ${f.section}\n${line}\n`
  }
  let at = -1
  for (let i = lo; i < hi; i++) if (ANY_FIELD_LINE.test(lines[i])) at = i
  if (at < 0) {
    if (h >= 0) { lines.splice(h + 1, 0, line); return lines.join('\n') }
    return md.replace(/\n*$/, '') + (md.trim() ? '\n' : '') + line + '\n'
  }
  while (at + 1 < hi && CONTINUATION.test(lines[at + 1])) at++
  lines.splice(at + 1, 0, line)
  return lines.join('\n')
}

const DEFAULTS_FILE = join(NEUTRAL, 'defaults.md')
const IDENTITY_FILE = join(NEUTRAL, 'identity.md')
const projectFile = (id) => join(NEUTRAL, 'projects', id, 'project.md')
const readMd = (p) => { try { return readFileSync(p, 'utf8') } catch { return '' } }
const validProjectId = (id) => typeof id === 'string' && /^[A-Za-z0-9._-]+$/.test(id) && !id.startsWith('.')

function devRootPath() {
  return expandHome(readField(readMd(IDENTITY_FILE), F('devRoot', 'dev root'))) || join(os.homedir(), 'Dev')
}

// A project's config is <data-home>/defaults.md overlaid by its project.md: a field
// or frontmatter key the project sets wins, anything it omits is inherited.
function readDefaults() { return readMd(DEFAULTS_FILE) }

// Build one repo record from projects/<name>/project.md, or null if it isn't a
// usable project. Shared by discovery, the config writes and the create/update tools.
function repoFromDir(name, devRoot = devRootPath(), defaults = readDefaults()) {
  let md
  try { md = readFileSync(projectFile(name), 'utf8') } catch { return null }
  const eff = (f) => effectiveField(md, defaults, f).value
  const slug = readField(md, REPO_F)
  let p = readField(md, PATH_F)
  p = p ? expandHome(p) : (slug ? join(devRoot, basename(slug)) : null)
  // Jira: key for matching ABC-1234 tokens, base URL to link them. Site name is
  // the parenthetical after cloudId (e.g. `...` (acme)); env wins.
  const site = eff(SITE_F)
  const jiraBase = process.env.JEEVES_JIRA_BASE || (site ? `https://${site}.atlassian.net/browse` : null)
  if (!p) return null
  const c = Object.fromEntries(CONFIG_FIELDS.project.map((f) => [f.key, eff(f)]))
  return { id: name, slug: slug || name, path: p, jiraKey: c.jiraKey, jiraBase, baseBranch: c.baseBranch, reviewCommand: c.reviewCommand, seedFiles: c.seedFiles || [] }
}

function discoverRepos() {
  const repos = []
  try {
    const devRoot = devRootPath(), defaults = readDefaults()
    for (const name of readdirSync(join(NEUTRAL, 'projects'))) {
      const r = repoFromDir(name, devRoot, defaults)
      if (r) repos.push(r)
    }
  } catch {}
  return repos
}

// projects/<id>/state.md as ledger rows (`- <kind> <id> · <state> · <next> · since
// <date>[ · k=v …]`), or the raw text of a legacy prose file.
function parseLedger(md) {
  if (md.trim() && !/^# state · /m.test(md)) return { ledger: false, raw: md }
  const rows = []
  for (const line of md.split('\n')) {
    if (!line.startsWith('- ')) continue
    const parts = line.slice(2).split(' · ').map((s) => s.trim())
    const [kind = '', ...id] = parts[0].split(/\s+/)
    let si = parts.findIndex((s, i) => i >= 2 && /^since\s/.test(s))
    if (si < 0) si = parts.length
    const next = parts.slice(2, si), extra = {}
    for (const s of parts.slice(si + 1)) {
      const kv = s.match(/^([\w.-]+)=(.*)$/)
      if (kv) extra[kv[1]] = kv[2]; else next.push(s)
    }
    rows.push({ kind, id: id.join(' '), state: parts[1] ?? '', next: next.join(' · '), since: parts[si]?.replace(/^since\s+/, '') ?? null, extra })
  }
  return { ledger: true, rows }
}

// Everything the Settings modal shows: defaults and identity values, and per
// project the effective config with where each value comes from, plus its ledger.
function configView() {
  const dmd = readDefaults(), imd = readMd(IDENTITY_FILE)
  const values = (md, fields) => Object.fromEntries(fields.map((f) => [f.key, readField(md, f)]))
  const projectKeys = new Set(CONFIG_FIELDS.project.map((f) => f.label || f.key))
  const projects = REPOS.map((r) => {
    const md = readMd(projectFile(r.id))
    const fields = Object.fromEntries(CONFIG_FIELDS.project.map((f) => [f.key, effectiveField(md, dmd, f)]))
    // Defaults this project replaces that the form doesn't edit (e.g. its own QA columns).
    const otherOverrides = [...new Set(CONFIG_FIELDS.defaults.filter((f) => !projectKeys.has(f.label || f.key) && readField(md, f) != null).map((f) => f.label || f.key))]
    return {
      id: r.id, slug: r.slug,
      repo: { value: r.slug, source: readField(md, REPO_F) ? 'project' : 'default' },
      path: { value: r.path, source: readField(md, PATH_F) ? 'project' : 'default' },
      fields, otherOverrides,
      state: parseLedger(readMd(join(NEUTRAL, 'projects', r.id, 'state.md')))
    }
  })
  return {
    home: NEUTRAL,
    defaults: { exists: existsSync(DEFAULTS_FILE), values: values(dmd, CONFIG_FIELDS.defaults) },
    identity: { exists: existsSync(IDENTITY_FILE), values: values(imd, CONFIG_FIELDS.identity) },
    projects
  }
}

// A submitted value as the file stores it: trimmed text or a list of trimmed
// items; blank or empty means unset (null). { error } for a value the format can't hold.
function normValue(f, v) {
  if (v == null) return null
  const items = f.kind === 'list' ? (Array.isArray(v) ? v : splitList(v)).map((s) => String(s).trim()).filter(Boolean) : [String(v).trim()]
  for (const s of items) {
    if (/[\r\n`]/.test(s) || (f.fm && f.kind === 'list' && s.includes(','))) return { error: `invalid value for ${f.key}` }
    if (s.includes('<')) return { error: `${f.key}: <…> is a placeholder — clear the field instead` }
  }
  if (f.kind === 'list') return items.length ? items : null
  if (!items[0]) return null
  if (CHOICES[f.key] && !CHOICES[f.key].includes(items[0])) return { error: `${f.key} must be one of ${CHOICES[f.key].join(', ')}` }
  const bad = FORMATS[f.key]?.(items[0])
  if (bad) return { error: `${f.key}: ${bad}` }
  return items[0]
}

// Apply { set: {key: value}, unset: [key] } to one config file, in place. For a
// project, a value equal to the inherited default is written as unset, so
// project.md only ever holds real overrides. Refreshes the live REPOS entries the
// file feeds and tells the UI to refetch.
async function writeConfig({ file, project, set = {}, unset = [] } = {}) {
  const fields = CONFIG_FIELDS[file]
  if (!fields) return { error: 'file must be defaults, identity or project' }
  if (typeof set !== 'object' || set === null || Array.isArray(set) || !Array.isArray(unset)) return { error: 'set must be an object, unset an array' }
  let path
  if (file === 'project') {
    if (!validProjectId(project) || !REPOS.find((r) => r.id === project)) return { error: 'unknown project' }
    path = projectFile(project)
  } else path = file === 'defaults' ? DEFAULTS_FILE : IDENTITY_FILE
  let md
  try { md = readFileSync(path, 'utf8') }
  catch {
    if (file === 'project') return { error: 'project.md not found' }
    md = readMd(join(__dirname, '..', 'templates', basename(path))) // first write starts from the template
  }
  const want = new Map([...unset.map((k) => [k, null]), ...Object.entries(set)])
  for (const k of want.keys()) if (!fields.some((f) => f.key === k)) return { error: 'unknown field: ' + k }
  const dmd = file === 'project' ? readDefaults() : ''
  for (const f of fields) { // table order, so a cloudId line exists before its site is set
    if (!want.has(f.key)) continue
    let v = normValue(f, want.get(f.key))
    if (v?.error) return v
    if (v != null && file === 'project' && JSON.stringify(v) === JSON.stringify(readField(dmd, f))) v = null
    md = f.fm ? writeFrontmatter(md, { [f.key]: v == null ? null : [v].flat().join(', ') }) : setMdField(md, f, v)
  }
  try { await writeFile(path, md) } catch (e) { return { error: 'write failed: ' + e.message } }
  // defaults.md and identity.md (dev root) feed every project; project.md only its own.
  const devRoot = devRootPath(), defaults = readDefaults()
  for (const r of REPOS) {
    if (file === 'project' && r.id !== project) continue
    const rec = repoFromDir(r.id, devRoot, defaults)
    if (rec) { Object.assign(r, rec); addRepoRoots(r) }
  }
  pushConfig()
  return { ok: true }
}

// ── Reminders: <data-home>/reminders.md ─────────────────────────────────────
// Rows `- <id> · due <YYYY-MM-DD HH:MM> · <what> · set <YYYY-MM-DD>` (BRIEF:
// Reminders), shared with the loop. Edits touch only the row they change; header
// lines and anything unrecognised are kept byte for byte.
const REMINDERS_FILE = join(NEUTRAL, 'reminders.md')
const REMINDERS_HEADER = '# reminders\n<!-- One row each: - <id> · due <YYYY-MM-DD HH:MM> · <what> · set <YYYY-MM-DD>. Delete on done. -->\n'
const REMINDER_ROW = /^- (r\d+) · due (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · (.*?)(?: · set (\d{4}-\d{2}-\d{2}))?[ \t]*$/
const pad2 = (n) => String(n).padStart(2, '0')
const localDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
const localStamp = (d) => `${localDay(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
// A local-time `YYYY-MM-DD HH:MM` (or the `T`-separated form a datetime input sends) → Date, or null.
function parseStamp(s) {
  const m = String(s || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/)
  if (!m) return null
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])
  return d.getMonth() === +m[2] - 1 && d.getHours() === +m[4] ? d : null
}
function parseReminders(md) {
  return md.split('\n').map((l) => l.match(REMINDER_ROW)).filter(Boolean)
    .map((m) => ({ id: m[1], due: m[2], what: m[3], set: m[4] ?? null }))
}
const remindersView = () => ({ reminders: parseReminders(readMd(REMINDERS_FILE)) })
// { op: 'add', what, due } | { op: 'done' | 'delete', id } | { op: 'snooze', id, by: '1h' | '1d' }
async function editReminders({ op, id, what, due, by } = {}) {
  const raw = readMd(REMINDERS_FILE), md = raw.trim() ? raw : REMINDERS_HEADER
  const lines = md.split('\n')
  let out
  if (op === 'add') {
    const text = String(what ?? '').trim(), when = parseStamp(due)
    if (!text || /[\r\n]/.test(text)) return { error: 'reminder text required, one line' }
    if (!when) return { error: 'due must be YYYY-MM-DD HH:MM' }
    const n = Math.max(0, ...[...md.matchAll(/^- r(\d+) · /gm)].map((x) => +x[1])) + 1
    const row = `- r${n} · due ${localStamp(when)} · ${text} · set ${localDay(new Date())}`
    const end = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
    lines.splice(end, 0, row)
    if (end === lines.length - 1) lines.push('')
    out = lines.join('\n')
  } else {
    const at = lines.findIndex((l) => l.match(REMINDER_ROW)?.[1] === id)
    if (at < 0) return { error: 'unknown reminder: ' + id }
    if (op === 'done' || op === 'delete') lines.splice(at, 1)
    else if (op === 'snooze') {
      const ms = { '1h': 3600e3, '1d': 86400e3 }[by]
      if (!ms) return { error: 'snooze by 1h or 1d' }
      const m = lines[at].match(REMINDER_ROW)
      const due = parseStamp(m[2]) // null for an impossible time (Feb 30, a DST-skipped hour)
      const from = Math.max(Date.now(), due ? due.getTime() : 0)
      lines[at] = lines[at].replace(` · due ${m[2]} · `, ` · due ${localStamp(new Date(from + ms))} · `)
    } else return { error: 'op must be add, done, delete or snooze' }
    out = lines.join('\n')
  }
  try { await writeFile(REMINDERS_FILE, out) } catch (e) { return { error: 'write failed: ' + e.message } }
  return { ok: true }
}

function settingsView() {
  return {
    loopConstraints: readMd(join(NEUTRAL, 'loop-constraints.md')),
    baseline: readMd(join(__dirname, '..', 'loop-constraints.md')), // shipped with the plugin
    home: NEUTRAL, host: HOST, port: +PORT, url: cockpitUrl(), tokenPinned: !!process.env.JEEVES_TOKEN,
    cockpit: cockpitView()
  }
}

// ── Agents: the plugin's agents/ (built-in) and <data-home>/agents/ (the user's) ──
// Claude Code agent markdown: frontmatter name, description, optional tools (comma
// list) and model, then the system prompt. The file name is the agent's name. A
// user file named like a built-in overrides it, and records the built-in's hash
// (`base`) so the UI can flag the override once the built-in changes. `dispatch`
// runs a worker session as the resolved agent (findAgent → agentArgs).
const BUILTIN_AGENTS_DIR = join(__dirname, '..', 'agents')
const AGENTS_DIR = join(NEUTRAL, 'agents')
const AGENT_NAME = /^[a-z][a-z0-9-]{1,40}$/
const AGENT_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Task']
const AGENT_MODELS = ['inherit', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5-1', 'claude-opus-5']
// Labels the loop dispatches under with the role in the prompt (BRIEF), so no agent may take them.
const DISPATCH_LABELS = ['planner', 'reviewer', 'worker']
const shortHash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12)
function readAgent(dir, name) {
  const md = readMd(join(dir, name + '.md'))
  if (!md) return null
  const { data, body } = splitFrontmatter(md)
  return {
    name, description: data.description || '', tools: splitList(data.tools), model: data.model || 'inherit',
    prompt: body.replace(/^\s*\n/, ''), ...(dir === BUILTIN_AGENTS_DIR ? { hash: shortHash(md) } : { base: data.base || null })
  }
}
function listAgents(dir) {
  let files = []
  try { files = readdirSync(dir) } catch {}
  return files.filter((f) => f.endsWith('.md') && AGENT_NAME.test(f.slice(0, -3))).sort()
    .map((f) => readAgent(dir, f.slice(0, -3))).filter(Boolean)
}
// Built-ins, each with the user's override when there is one (`stale` once the built-in
// has changed since it was customised); then the user's own agents.
function agentsView() {
  const builtin = listAgents(BUILTIN_AGENTS_DIR), mine = listAgents(AGENTS_DIR)
  const names = new Set(builtin.map((a) => a.name))
  return {
    builtin: builtin.map((b) => {
      const o = mine.find((a) => a.name === b.name)
      return { ...b, override: o ? { ...o, stale: o.base !== b.hash } : null }
    }),
    custom: mine.filter((a) => !names.has(a.name)),
    choices: { tools: AGENT_TOOLS, models: AGENT_MODELS }
  }
}
// The agent a name resolves to — the user's file (custom, or an override of a
// built-in), else the built-in — with its kind; null for a label.
function findAgent(name) {
  if (typeof name !== 'string' || !AGENT_NAME.test(name)) return null
  const b = readAgent(BUILTIN_AGENTS_DIR, name), u = readAgent(AGENTS_DIR, name)
  if (u) return { ...u, kind: b ? 'override' : 'custom' }
  return b ? { ...b, kind: 'builtin' } : null
}
// { op: 'save', agent: { name, description, tools, model, prompt }, isNew? } | { op: 'delete', name }.
// Saving a built-in's name writes an override; deleting one restores the built-in.
// Only <data-home>/agents/ is ever written.
async function editAgents({ op, agent, name, isNew } = {}) {
  const n = op === 'save' ? agent?.name : name
  if (typeof n !== 'string' || !AGENT_NAME.test(n)) return { error: 'name must match ^[a-z][a-z0-9-]{1,40}$' }
  if (DISPATCH_LABELS.includes(n)) return { error: `${n} is reserved for the loop's own dispatches` }
  const file = join(AGENTS_DIR, n + '.md')
  if (dirname(file) !== AGENTS_DIR) return { error: 'invalid name' }
  if (op === 'delete') {
    try { await unlink(file) } catch { return { error: 'unknown agent: ' + n } }
    return { ok: true }
  }
  if (op !== 'save') return { error: 'op must be save or delete' }
  const { description, tools = [], model = 'inherit', prompt } = agent
  if (typeof description !== 'string' || !description.trim() || /[\r\n]/.test(description)) return { error: 'description required, one line' }
  if (!Array.isArray(tools) || tools.some((t) => !AGENT_TOOLS.includes(t))) return { error: 'tools must be from ' + AGENT_TOOLS.join(', ') }
  if (!AGENT_MODELS.includes(model)) return { error: 'model must be one of ' + AGENT_MODELS.join(', ') }
  if (typeof prompt !== 'string' || !prompt.trim()) return { error: 'prompt required' }
  const builtin = readAgent(BUILTIN_AGENTS_DIR, n)
  if (isNew && (builtin || existsSync(file))) return { error: `an agent named ${n} already exists${builtin ? ' (built-in — customise it instead)' : ''}` }
  const md = writeFrontmatter(prompt.trim() + '\n', {
    name: n, description: description.trim(), tools: [...new Set(tools)].join(', '), model, base: builtin?.hash
  })
  try { mkdirSync(AGENTS_DIR, { recursive: true }); await writeFile(file, md) } catch (e) { return { error: 'write failed: ' + e.message } }
  return { ok: true }
}
// A dispatched session runs as `a`, defined inline so its tool list keeps the bus tools
// workerPreamble needs; the model is set by --model (workerModelFor). SendMessage and MCP
// tools are deferred, so ToolSearch must come too or the session can't load them to report.
const BUS_TOOLS = ['mcp__cockpit__report', 'SendMessage', 'ToolSearch']
function agentArgs(a) {
  const def = { description: a.description, prompt: a.prompt }
  if (a.tools.length) def.tools = [...a.tools, ...BUS_TOOLS]
  return ['--agents', JSON.stringify({ [a.name]: def }), '--agent', a.name]
}
// The user's agent (custom or override) picks its own model unless it inherits; else
// the loop's model or the configured worker model, with any Opus pinned (pinOpus).
const workerModelFor = (a, model) => (a && a.kind !== 'builtin' && a.model !== 'inherit' ? a.model : pinOpus(model || cfg('workerModel')))

const REPOS = discoverRepos()
const worktreeBase = (repo) => repo.path + '-worktrees'
// The Scratchpad space is rooted at the user's home dir (their request: a general
// terminal area). This deliberately widens the cwd allowlist to the whole home
// tree — acceptable because the server is loopback-only and token-gated, and the
// scratchpad is user-initiated. Set JEEVES_SCRATCH_ROOT to narrow it.
const SCRATCH_ROOT = process.env.JEEVES_SCRATCH_ROOT || os.homedir()
// Allow the main checkouts, their sibling worktree dirs, the neutral home, and the scratch root.
const ROOTS = [...REPOS.flatMap((r) => [r.path, worktreeBase(r)]), NEUTRAL, SCRATCH_ROOT].map((p) => normalize(p))
// Real worktree paths can sit outside the convention dir (other tools' worktrees);
// learn them from `git worktree list` so those spaces are allowed too.
const dynRoots = new Set()
// A project created at runtime isn't in the static ROOTS, so allow its checkout
// and worktree dir via dynRoots (the same set git-discovered worktrees use).
const addRepoRoots = (r) => { dynRoots.add(normalize(r.path)); dynRoots.add(normalize(worktreeBase(r))) }
const inRoots = (list, n) => { for (const root of list) if (n === root || n.startsWith(root + sep)) return true; return false }
function allowedCwd(cwd) {
  const n = normalize(cwd)
  return inRoots(ROOTS, n) || inRoots(dynRoots, n)
}

// The last line of a command's stderr. git's progress ("Updating files: 40%") is
// carriage-return separated, so split on both.
const lastLine = (s) => String(s).trim().split(/[\r\n]+/).pop()

function runGit(cwd, args, timeout = 15000) {
  return new Promise((res) => {
    execFile('git', ['-C', cwd, ...args], { timeout }, (err, stdout, stderr) => {
      res({ ok: !err, out: stdout || '', err: (stderr || (err ? String(err.message) : '')).trim() })
    })
  })
}

async function listWorktrees(repo) {
  const { ok, out } = await runGit(repo.path, ['worktree', 'list', '--porcelain'])
  if (!ok) return []
  const items = []
  let cur = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9).trim(), branch: null }; items.push(cur) }
    else if (line.startsWith('branch ') && cur) cur.branch = line.slice(7).replace('refs/heads/', '').trim()
    else if (line.startsWith('detached') && cur) cur.branch = '(detached)'
  }
  return items.map((w) => ({ ...w, isMain: normalize(w.path) === normalize(repo.path) }))
}

async function refreshWorktreeRoots() {
  for (const repo of REPOS) for (const w of await listWorktrees(repo)) dynRoots.add(normalize(w.path))
}

async function listBranches(repo) {
  const [lh, rh] = await Promise.all([
    runGit(repo.path, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    runGit(repo.path, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'])
  ])
  const local = lh.ok ? lh.out.split('\n').map((s) => s.trim()).filter(Boolean) : []
  const localSet = new Set(local)
  const remote = []
  if (rh.ok) {
    for (const line of rh.out.split('\n')) {
      const b = line.trim()
      if (!b || !b.startsWith('origin/') || b.endsWith('/HEAD')) continue
      const short = b.slice('origin/'.length)
      if (!localSet.has(short)) remote.push(short)
    }
  }
  return { local: local.sort(), remote: [...new Set(remote)].sort() }
}

function listPRs(repo) {
  return new Promise((res) => {
    execFile('gh', ['pr', 'list', '--repo', repo.slug, '--state', 'open', '--limit', '50', '--json', 'number,title,headRefName,author'],
      { cwd: repo.path, timeout: 15000 }, (err, stdout, stderr) => {
        if (err) return res({ error: lastLine(stderr || err.message || 'gh failed') })
        try {
          const prs = JSON.parse(stdout).map((p) => ({ number: p.number, title: p.title, branch: p.headRefName, author: p.author?.login || '' }))
          res({ prs })
        } catch { res({ error: 'could not parse gh output' }) }
      })
  })
}

// A PR's statusCheckRollup as one verdict: any failure fails, else anything still
// running is pending, else pass. No checks → null.
// One rollup entry → pass / fail / pending. A CheckRun carries status + conclusion;
// a commit StatusContext carries only state.
const checkState = (c) => c.state
  ? (c.state === 'SUCCESS' ? 'pass' : c.state === 'PENDING' || c.state === 'EXPECTED' ? 'pending' : 'fail')
  : (c.status && c.status !== 'COMPLETED') ? 'pending' : (c.conclusion === 'SUCCESS' || c.conclusion === 'NEUTRAL' || c.conclusion === 'SKIPPED') ? 'pass' : 'fail'
function rollupChecks(roll) {
  if (!roll?.length) return null
  const states = roll.map(checkState)
  return states.includes('fail') ? 'fail' : states.includes('pending') ? 'pending' : 'pass'
}

// One PR's body, headline stats, branches, reviews and checks, for the PR modal and
// the space panel's PR tab.
function prView(repo, number) {
  return new Promise((res) => {
    execFile('gh', ['pr', 'view', String(number), '--repo', repo.slug, '--json', 'number,title,body,url,state,isDraft,reviewDecision,author,additions,deletions,changedFiles,headRefName,baseRefName,statusCheckRollup,latestReviews'],
      { cwd: repo.path, timeout: 15000 }, (err, stdout, stderr) => {
        if (err) return res({ error: lastLine(stderr || err.message || 'gh failed') })
        try {
          const p = JSON.parse(stdout)
          res({
            number: p.number, title: p.title, body: p.body || '', url: p.url, state: p.state, isDraft: !!p.isDraft,
            reviewDecision: p.reviewDecision || null, author: p.author?.login || '', additions: p.additions, deletions: p.deletions,
            changedFiles: p.changedFiles, head: p.headRefName || null, base: p.baseRefName || null, checks: rollupChecks(p.statusCheckRollup),
            checkRuns: (p.statusCheckRollup || []).map((c) => ({ name: c.name || c.context || 'check', state: checkState(c), url: c.detailsUrl || c.targetUrl || null })),
            reviews: (p.latestReviews || []).map((r) => ({ author: r.author?.login || '', state: r.state }))
          })
        } catch { res({ error: 'could not parse gh output' }) }
      })
  })
}

// What a BRAND-NEW branch is cut from: the project's configured base branch
// (project.md "base branch", e.g. `qa`), else origin's default
// (main/master). Fetched first so a new branch is never based on a stale local
// copy. Returns the ref to branch from, or null → caller falls back to HEAD.
async function resolveBaseRef(repo) {
  const base = await defaultBase(repo)
  await runGit(repo.path, ['fetch', 'origin', base]) // make the base current before branching
  if ((await runGit(repo.path, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/' + base])).ok) return 'origin/' + base
  if ((await runGit(repo.path, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + base])).ok) return base
  return null
}

// The project's base branch name: configured, else origin's default, else main.
async function defaultBase(repo) {
  if (repo.baseBranch) return repo.baseBranch
  const sym = await runGit(repo.path, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
  return sym.ok ? sym.out.trim().replace('refs/remotes/origin/', '') : 'main'
}

async function createWorktree(repo, branch) {
  const name = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.\.+/g, '-').replace(/^[.\-]+|[.\-]+$/g, '') || 'wt'
  const wt = join(worktreeBase(repo), name)
  const localEx = (await runGit(repo.path, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch])).ok
  const remoteEx = !localEx && (await runGit(repo.path, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/' + branch])).ok
  const created = !localEx && !remoteEx
  // A brand-new branch is cut from the freshly-fetched project base (never stale HEAD).
  const baseRef = created ? await resolveBaseRef(repo) : null
  const args = localEx
    ? ['worktree', 'add', wt, branch]
    : remoteEx
      ? ['worktree', 'add', '--track', '-b', branch, wt, 'origin/' + branch]
      : baseRef
        ? ['worktree', 'add', '-b', branch, wt, baseRef]
        : ['worktree', 'add', '-b', branch, wt]
  // Checking out a big repo (thousands of files, a slow Windows disk) takes well over the 15 s
  // default, and a killed checkout reads as a failure though it was nearly done.
  const r = await runGit(repo.path, args, 5 * 60 * 1000)
  if (!r.ok) return { error: lastLine(r.err || 'worktree add failed') }
  await excludeReportFile(repo)
  // Seed gitignored files (e.g. .env) from the main checkout — they never travel
  // with the branch. Never clobber a file the worktree already has. Each entry must
  // resolve INSIDE both trees — reject `..`/absolute escapes so a crafted seedFiles
  // value can't turn this into an arbitrary file copy.
  const seeded = []
  const inside = (root, p) => { const n = normalize(p); const r = normalize(root); return n === r || n.startsWith(r + sep) }
  for (const f of repo.seedFiles || []) {
    const src = join(repo.path, f), dst = join(wt, f)
    if (!inside(repo.path, src) || !inside(wt, dst)) continue // escapes the tree — skip
    try { if (existsSync(src) && !existsSync(dst)) { copyFileSync(src, dst); seeded.push(f) } } catch {}
  }
  return { path: wt, branch, created, base: baseRef, seeded }
}

// Resolve a worktree for a branch: reuse the one that already has it checked out,
// otherwise create it (handles local / origin / brand-new).
async function openBranchWorktree(repo, branch) {
  const existing = (await listWorktrees(repo)).find((w) => w.branch === branch)
  if (existing) return { path: existing.path, branch, reused: true }
  return createWorktree(repo, branch)
}

// Every worker writes JEEVES_REPORT.md at its worktree root (workerPreamble). Keep it
// out of git via the repo's shared info/exclude, so it never lands in a worker's
// commit and never counts as an uncommitted change when the worktree is removed.
const REPORT_FILE = 'JEEVES_REPORT.md'
async function excludeReportFile(repo) {
  const r = await runGit(repo.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!r.ok) return
  const f = join(r.out.trim(), 'info', 'exclude')
  try {
    const cur = existsSync(f) ? readFileSync(f, 'utf8') : ''
    if (cur.split('\n').includes('/' + REPORT_FILE)) return
    mkdirSync(dirname(f), { recursive: true })
    appendFileSync(f, (cur && !cur.endsWith('\n') ? '\n' : '') + '/' + REPORT_FILE + '\n')
  } catch {}
}

async function removeWorktree(repo, wt, force) {
  // Idempotent: something outside this process (a manual `git worktree remove`,
  // a crash mid-operation, another tool) may have already removed the worktree
  // dir or dropped it from git's registry. Treat "already gone" as success —
  // otherwise closeWork can never clear the bus entry, and it's stuck in the
  // cockpit's dispatched list forever (exited, unclosable) since bus.workers is
  // only deleted on a successful removeWorktree.
  if (!existsSync(wt)) { await runGit(repo.path, ['worktree', 'prune']); return { ok: true } }
  await excludeReportFile(repo) // worktrees made before the exclude existed
  const st = await runGit(wt, ['status', '--porcelain'])
  if (!st.ok && !force) return { error: 'could not check worktree status — refusing' }
  if (st.ok && st.out.trim() && !force) return { error: 'worktree has uncommitted changes — refusing' }
  // git refuses a plain remove of any worktree with submodules, even a clean one,
  // so pass --force once status has confirmed it's clean (or the caller forced).
  // Deleting a big worktree (node_modules, submodules) takes well over the default
  // git timeout, and killing git mid-delete leaves a half-removed directory that
  // blocks the next dispatch on that branch — so give it five minutes.
  const r = await runGit(repo.path, ['worktree', 'remove', '--force', wt], 5 * 60 * 1000)
  if (!r.ok) {
    const msg = lastLine(r.err || 'remove failed')
    // Same idempotency for git-side-only staleness (gitdir points nowhere, or
    // git already considers it not a worktree) — prune and treat as done rather
    // than orphaning the bus entry.
    if (/not a working tree|does not exist|is not a working tree/i.test(msg)) {
      await runGit(repo.path, ['worktree', 'prune'])
      return { ok: true }
    }
    return { error: msg }
  }
  return { ok: true }
}

// Reveal a folder in the OS. 'editor' → VS Code (`code`), falling back on macOS
// to `open -a`; 'files' → the platform file manager. Fire-and-forget: we don't
// wait on the GUI app, only report whether the launcher spawned.
function openInOs(cwd, target) {
  const plat = process.platform
  let file, args
  if (target === 'editor') {
    file = 'code'; args = ['-n', cwd]
  } else {
    file = plat === 'darwin' ? 'open' : plat === 'win32' ? 'explorer' : 'xdg-open'
    args = [cwd]
  }
  try {
    const child = execFile(file, args, { timeout: 10000 }, (err) => {
      // On macOS, fall back to launching VS Code by app name when `code` isn't on PATH.
      if (err && target === 'editor' && plat === 'darwin') execFile('open', ['-a', 'Visual Studio Code', cwd], () => {})
    })
    child.on('error', () => {})
    return { ok: true }
  } catch (e) { return { error: e.message } }
}

function readBody(req) {
  return new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { r(JSON.parse(b || '{}')) } catch { r({}) } }) })
}

// Memory of the cockpit and everything it spawned (the PTYs and their children —
// claude/codex/shell — which is what actually costs memory, not the Node server
// alone), summed over the process tree rooted at pid. On macOS each process counts
// its physical footprint (from `top`, what Activity Monitor shows); summed RSS
// counts shared pages once per process and overstates a tree of claudes by about
// a third. Elsewhere, or if `top` fails, it falls back to RSS; on Windows, the
// working set from Win32_Process.
// The health poll fires every ~5s per open tab; cache the (whole-process-table)
// scan briefly so concurrent/back-to-back polls reuse one result. PowerShell takes
// ~1 s to start, so Windows caches longer; concurrent polls share one scan.
let _treeMemCache = { at: 0, val: null }, _treeMemScan = null
async function cachedTreeMem() {
  if (Date.now() - _treeMemCache.at < (WIN ? 15000 : 4000)) return _treeMemCache.val
  _treeMemScan ??= processTreeMem(process.pid).then((val) => { _treeMemCache = { at: Date.now(), val }; _treeMemScan = null; return val })
  return _treeMemScan
}

const execOut = (file, args, timeout = 4000) => new Promise((res) => {
  execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, out) => res(err ? null : out))
})

// pid → bytes of physical footprint, from one `top` sample (MEM is e.g. 262M, 4208K, 1.2G+).
async function footprints() {
  if (process.platform !== 'darwin') return null
  const out = await execOut('top', ['-l', '1', '-stats', 'pid,mem'])
  if (!out) return null
  const unit = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }
  const mem = new Map()
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+([\d.]+)([BKMG])[+-]?$/)
    if (m) mem.set(+m[1], +m[2] * unit[m[3]])
  }
  return mem.size ? mem : null
}

// "pid ppid working-set-bytes" per process — Windows has no ps.
const WIN_PS = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.WorkingSetSize)" }'
let _treeMemWarned = false
async function processTreeMem(rootPid) {
  const [out, fp] = await Promise.all([
    WIN ? execOut('powershell', ['-NoProfile', '-NonInteractive', '-Command', WIN_PS], 10000) : execOut('ps', ['-axo', 'pid=,ppid=,rss=']),
    footprints()
  ])
  if (!out) { if (!_treeMemWarned) { _treeMemWarned = true; console.error(`processTreeMem: ${WIN ? 'Win32_Process query' : 'ps'} failed — memory figure hidden`) } return null }
  const rss = new Map(), kids = new Map()
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/)
    if (!m) continue
    const pid = +m[1], ppid = +m[2]
    rss.set(pid, +m[3] * (WIN ? 1 : 1024)); (kids.get(ppid) || kids.set(ppid, []).get(ppid)).push(pid) // ps rss is KiB, WorkingSetSize bytes
  }
  if (!rss.has(rootPid)) return null // ps ran but our own pid isn't in it → unreliable, don't report a false 0
  let total = 0; const seen = new Set(), stack = [rootPid]
  while (stack.length) {
    const p = stack.pop(); if (seen.has(p)) continue; seen.add(p)
    total += fp?.get(p) ?? rss.get(p) ?? 0
    for (const c of kids.get(p) || []) stack.push(c)
  }
  return total
}

function gitStatus(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'status', '--porcelain=v1', '-b'], { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve({ git: false, branch: null, upstream: null, changed: 0, ahead: 0, behind: 0 })
      let branch = null, upstream = null, ahead = 0, behind = 0, changed = 0
      for (const l of stdout.split('\n')) {
        if (!l) continue
        if (l.startsWith('## ')) {
          const [head, rest] = l.slice(3).split('...')
          branch = head.split(' ')[0]
          upstream = rest ? rest.split(' ')[0] : null
          ahead = +((l.match(/ahead (\d+)/) || [])[1] || 0)
          behind = +((l.match(/behind (\d+)/) || [])[1] || 0)
        } else changed++
      }
      resolve({ git: true, branch, upstream, changed, ahead, behind })
    })
  })
}

// A porcelain-status kind letter → coarse kind for the file badge.
const kindFromStatus = (x) => x === 'A' ? 'added' : x === 'D' ? 'deleted' : x === 'R' ? 'renamed' : 'modified'

// Changed files for the space panel. Two modes:
//  • worktree (default) — uncommitted changes (working tree vs HEAD, untracked in).
//  • base = <branch> — the PR diff: committed changes vs the merge-base with <base>
//    (three-dot), i.e. what the PR actually adds against its target.
// A base branch name → the ref to diff against: origin's copy when there is one
// (what a PR is compared with; a local branch may be stale), else the local name.
async function diffBase(cwd, base) {
  if (!base || base.startsWith('-')) return undefined
  return (await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/' + base])).ok ? 'origin/' + base : base
}

async function gitChanges(cwd, base) {
  base = await diffBase(cwd, base)
  const hb = await runGit(cwd, ['status', '--porcelain=v1', '-b'])
  let branch = null, ahead = 0, behind = 0
  for (const l of hb.out.split('\n')) if (l.startsWith('## ')) {
    branch = l.slice(3).split('...')[0].split(' ')[0]
    ahead = +((l.match(/ahead (\d+)/) || [])[1] || 0)
    behind = +((l.match(/behind (\d+)/) || [])[1] || 0)
  }
  const files = []
  if (base) {
    const d = await runGit(cwd, ['diff', '--name-status', '--find-renames', '-z', `${base}...HEAD`])
    if (!d.ok) return { git: false, files: [], branch, ahead, behind }
    const parts = d.out.split('\0')
    for (let i = 0; i < parts.length; i++) {
      const code = parts[i]; if (!code) continue
      const x = code[0]
      let path = parts[++i] || ''
      if (x === 'R' || x === 'C') path = parts[++i] || path // rename: old\0new — keep new
      if (path) files.push({ path, xy: code, kind: kindFromStatus(x), staged: true })
    }
  } else {
    const st = await runGit(cwd, ['status', '--porcelain=v1', '-uall', '-z'])
    if (!st.ok) return { git: false, files: [] }
    const parts = st.out.split('\0')
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i]; if (!e) continue
      const xy = e.slice(0, 2), rest = e.slice(3)
      const path = rest // porcelain -z lists the NEW path first for a rename/copy…
      const from = xy[0] === 'R' || xy[0] === 'C' ? parts[++i] : undefined // …and the OLD path as the next record
      const untracked = xy === '??'
      const kind = untracked ? 'added' : xy.includes('D') ? 'deleted' : kindFromStatus(xy[0] === ' ' ? xy[1] : xy[0])
      files.push({ path, from, xy, kind, staged: !untracked && xy[0] !== ' ' && xy[0] !== '?' })
    }
  }
  // Lines added/removed per file (tracked changes; binary files report none).
  const ns = await runGit(cwd, ['diff', '--numstat', '--find-renames', '-z', base ? `${base}...HEAD` : 'HEAD'])
  if (ns.ok) {
    const lines = new Map()
    const parts = ns.out.split('\0')
    for (let i = 0; i < parts.length; i++) {
      const m = parts[i].match(/^(\d+|-)\t(\d+|-)\t(.*)$/)
      if (!m) continue
      let path = m[3]
      if (!path) { i++; path = parts[++i] || '' } // rename: "a\td\t" then old\0new — keep new
      if (m[1] !== '-') lines.set(path, { add: +m[1], del: +m[2] })
    }
    for (const f of files) { const l = lines.get(f.path); if (l) Object.assign(f, l) }
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { git: true, branch, ahead, behind, files }
}

// Old/new contents of one changed file, for a Monaco diff. worktree mode: HEAD vs
// working tree. base mode: merge-base(base,HEAD) vs HEAD (matches the PR diff).
const DIFF_MAX = 2 * 1024 * 1024
async function fileDiff(cwd, rel, base) {
  base = await diffBase(cwd, base)
  const abs = normalize(join(cwd, rel))
  if (abs !== normalize(cwd) && !abs.startsWith(normalize(cwd) + sep)) return { error: 'path outside worktree' }
  let old = '', now = ''
  if (base) {
    const mb = await runGit(cwd, ['merge-base', base, 'HEAD'])
    const ref = mb.ok ? mb.out.trim() : base
    const oldShow = await runGit(cwd, ['show', `${ref}:${rel}`])
    old = oldShow.ok ? oldShow.out : ''
    const newShow = await runGit(cwd, ['show', `HEAD:${rel}`])
    now = newShow.ok ? newShow.out : ''
  } else {
    const head = await runGit(cwd, ['show', `HEAD:${rel}`])
    old = head.ok ? head.out : ''
    try { if (existsSync(abs)) now = readFileSync(abs, 'utf8') } catch {}
  }
  if (old.length > DIFF_MAX || now.length > DIFF_MAX) return { error: 'file too large to diff' }
  if (old.includes('\0') || now.includes('\0')) return { binary: true, path: rel }
  return { path: rel, old, new: now }
}

// Discard one file's uncommitted changes, staged and unstaged: back to HEAD. The
// entry is re-read from git status rather than trusted from the client. Untracked →
// deleted; staged-new → unstaged and deleted (restore does both); a rename restores
// the old path and drops the new one.
async function revertFile(cwd, rel) {
  const abs = normalize(join(cwd, rel))
  if (abs === normalize(cwd) || !abs.startsWith(normalize(cwd) + sep)) return { error: 'path outside worktree' }
  const f = (await gitChanges(cwd)).files.find((x) => x.path === rel)
  if (!f) return { error: 'no uncommitted changes to ' + rel }
  if (f.xy === '??') {
    try { unlinkSync(abs) } catch (e) { return { error: e.message } }
    return { ok: true }
  }
  const r = await runGit(cwd, ['restore', '--source=HEAD', '--staged', '--worktree', '--', rel, ...(f.from ? [f.from] : [])])
  return r.ok ? { ok: true } : { error: r.err?.trim() || r.out.trim() || 'git restore failed' }
}

// PR + checks state for the branch checked out in cwd (for the space panel).
// The panel polls every 5s per open panel per browser tab; cache per cwd+branch
// for 30s so that isn't one `gh` process and GitHub API call every 5s each.
const PR_TTL = 30 * 1000
const _prCache = new Map()
async function prStatus(cwd) {
  const br = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const key = cwd + '\0' + (br.ok ? br.out.trim() : '')
  const hit = _prCache.get(key)
  if (hit && Date.now() - hit.at < PR_TTL) return hit.val
  for (const [k, v] of _prCache) if (Date.now() - v.at >= PR_TTL) _prCache.delete(k)
  const val = await prStatusUncached(cwd)
  _prCache.set(key, { at: Date.now(), val })
  return val
}
async function prStatusUncached(cwd) {
  const br = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!br.ok) return { error: 'no git' }
  const branch = br.out.trim()
  const repo = REPOS.find((r) => { const n = normalize(cwd); return n === normalize(r.path) || n.startsWith(normalize(worktreeBase(r)) + sep) || n === normalize(worktreeBase(r)) })
  if (!repo) return { branch, pr: null }
  const base = await defaultBase(repo)
  return new Promise((res) => {
    execFile('gh', ['pr', 'list', '--repo', repo.slug, '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,title,url,state,isDraft,reviewDecision,baseRefName,statusCheckRollup'],
      { cwd: repo.path, timeout: 15000 }, (err, stdout) => {
        if (err) return res({ branch, defaultBase: base, pr: null })
        try {
          const p = JSON.parse(stdout)[0]
          if (!p) return res({ branch, defaultBase: base, pr: null })
          res({ branch, defaultBase: base, pr: { number: p.number, title: p.title, url: p.url, state: p.state, isDraft: !!p.isDraft, reviewDecision: p.reviewDecision || null, base: p.baseRefName || null }, checks: rollupChecks(p.statusCheckRollup) })
        } catch { res({ branch, defaultBase: base, pr: null }) }
      })
  })
}

const CT = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.png': 'image/png'
}
function sendJson(res, obj, code = 200) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname

  // ── MCP control plane (token-gated via Authorization header from --mcp-config) ──
  if (path === '/mcp') {
    if (!authed(req, url)) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'unauthorized' })) }
    return handleMcp(req, res)
  }

  // ── API (token-gated; static assets below stay open so the page can boot) ──
  if (path.startsWith('/api/')) {
    if (!authed(req, url)) return sendJson(res, { error: 'unauthorized' }, 401)
  }
  if (path === '/api/config') return sendJson(res, { repos: REPOS, home: NEUTRAL, scratchRoot: SCRATCH_ROOT, appearance: appearance() })
  // Health for the bottom-left connected pill: server memory + live PTY counts by kind.
  if (path === '/api/health') {
    const counts = { orch: 0, worker: 0, claude: 0, codex: 0, shell: 0 }
    for (const s of sessions.values()) counts[s.kind] = (counts[s.kind] || 0) + 1
    const claudes = counts.orch + counts.worker + counts.claude // every claude-family PTY
    const treeMem = await cachedTreeMem() // server + all spawned agents (cached ~4s across polls)
    return sendJson(res, {
      ok: true,
      uptime: Math.round(process.uptime()),
      serverRss: process.memoryUsage().rss, // the Node server alone
      treeMem,                              // server + PTYs + their children (null if the probe failed)
      sysTotal: os.totalmem(),
      sysFree: os.freemem(),                // free system memory (drops as things run)
      sessions: { ...counts, claudes, total: sessions.size }
    })
  }
  if (path === '/api/orch/context') return sendJson(res, readOrchContext())
  if (req.method === 'GET' && path === '/api/layout') return sendJson(res, { layout })
  // `from` is the saving browser's id, so it can skip its own echo.
  if (req.method === 'POST' && path === '/api/layout') {
    const body = await readBody(req)
    if (!body.layout || typeof body.layout !== 'object' || !Array.isArray(body.layout.spaces)) return sendJson(res, { error: 'bad layout' }, 400)
    saveLayout(body.layout)
    broadcast({ t: 'layout', layout, from: String(body.from || '') })
    return sendJson(res, { ok: true })
  }
  if (req.method === 'POST' && path === '/api/orch/restart') { const r = restartOrchestrator(); return sendJson(res, r, r.error ? 400 : 200) }
  if (req.method === 'POST' && path === '/api/orch/input') {
    const body = await readBody(req)
    const s = sessions.get('orch:main')
    if (!s) return sendJson(res, { error: 'orchestrator not running' }, 400)
    if (typeof body.text === 'string' && body.text) { try { s.term.write(body.text + (body.submit ? '\r' : '')) } catch {} }
    return sendJson(res, { ok: true })
  }
  // Lifecycle pings from per-session Claude Code hooks. Never fail one — a non-200
  // would surface as a hook error in the session; just no-op on anything unknown.
  if (req.method === 'POST' && path === '/api/hook') {
    const body = await readBody(req)
    const id = body.id, next = body.status
    // Follow the live session id: /clear and /resume switch claude to a new one, and
    // a respawn that resumes the stale id comes back blank.
    const liveSid = typeof body.sessionId === 'string' && /^[0-9a-f-]{36}$/i.test(body.sessionId) ? body.sessionId : null
    if (liveSid && id === 'orch:main' && liveSid !== ORCH_SESSION_ID) setOrchSessionId(liveSid)
    if (liveSid && bus.workers.has(id) && bus.workers.get(id).sessionId !== liveSid) { bus.workers.get(id).sessionId = liveSid; saveWorkers() }
    if (liveSid && tabSessions.has(id) && tabSessions.get(id).sessionId !== liveSid) { tabSessions.get(id).sessionId = liveSid; saveTabs() }
    if (id === 'orch:main') {
      const was = orchStatus
      orchStatus = applyHookStatus(orchStatus, next)
      if (orchStatus !== 'idle') orchIdleSince = 0
      else if (was !== 'idle' || !orchIdleSince) orchIdleSince = Date.now()
      lastContext = { ...lastContext, status: orchStatus, updatedAt: Date.now() }
      pushContext()
    } else if (bus.workers.has(id)) {
      const w = bus.workers.get(id)
      w.status = applyHookStatus(w.status, next); w.updatedAt = Date.now(); saveWorkers(); pushSpaces()
    } else if (id) {
      // A user-opened claude tab (sid = spaceId:tabId).
      const nx = applyHookStatus(sessionStatus.get(id) ?? 'idle', next)
      sessionStatus.set(id, nx)
      pushSessionStatus(id, nx)
    }
    return sendJson(res, { ok: true })
  }
  if (path === '/api/spaces') return sendJson(res, { spaces: workerList() })
  if (req.method === 'DELETE' && path === '/api/work') {
    const out = await closeWork(url.searchParams.get('workId'), { removeWorktree: url.searchParams.get('worktree') === '1', force: url.searchParams.get('force') === '1' })
    return sendJson(res, out, out.error ? 400 : 200)
  }
  if (path === '/api/git') {
    const cwd = url.searchParams.get('cwd')
    if (!cwd || !allowedCwd(cwd)) return sendJson(res, { error: 'cwd not allowed' }, 400)
    return sendJson(res, await gitStatus(cwd))
  }
  // Space git panel: changed files, one file's diff, and PR/checks state.
  if (path === '/api/changes') {
    const cwd = url.searchParams.get('cwd'), base = url.searchParams.get('base') || undefined
    if (!cwd || !allowedCwd(cwd)) return sendJson(res, { error: 'cwd not allowed' }, 400)
    return sendJson(res, await gitChanges(cwd, base))
  }
  if (path === '/api/filediff') {
    const cwd = url.searchParams.get('cwd'), rel = url.searchParams.get('path'), base = url.searchParams.get('base') || undefined
    if (!cwd || !allowedCwd(cwd)) return sendJson(res, { error: 'cwd not allowed' }, 400)
    if (!rel) return sendJson(res, { error: 'path required' }, 400)
    return sendJson(res, await fileDiff(cwd, rel, base))
  }
  if (req.method === 'POST' && path === '/api/revert') {
    const { cwd, path: rel } = await readBody(req)
    if (!cwd || !allowedCwd(cwd)) return sendJson(res, { error: 'cwd not allowed' }, 400)
    if (!rel) return sendJson(res, { error: 'path required' }, 400)
    const out = await revertFile(cwd, rel)
    return sendJson(res, out, out.error ? 400 : 200)
  }
  if (path === '/api/prstatus') {
    const cwd = url.searchParams.get('cwd')
    if (!cwd || !allowedCwd(cwd)) return sendJson(res, { error: 'cwd not allowed' }, 400)
    return sendJson(res, await prStatus(cwd))
  }
  // Drop a file into a space: written to <cwd>/.jeeves-uploads/. That folder
  // self-ignores (a `*` .gitignore) so uploads never dirty the worktree. Returns
  // the path relative to cwd, which the UI drops into the session's input.
  if (req.method === 'POST' && path === '/api/upload') {
    const cwd = url.searchParams.get('cwd'), name = url.searchParams.get('name')
    if (!cwd || !allowedCwd(cwd)) return sendJson(res, { error: 'cwd not allowed' }, 400)
    if (!name) return sendJson(res, { error: 'name required' }, 400)
    const safe = basename(String(name)).replace(/[^A-Za-z0-9._ -]/g, '_') || 'file'
    const dir = join(cwd, '.jeeves-uploads')
    const chunks = []; let size = 0, aborted = false
    // Past the cap, stop buffering but let the body drain, so 'end' still sends the 413.
    req.on('data', (c) => { if (aborted) return; size += c.length; if (size > MAX_UPLOAD) { aborted = true; chunks.length = 0 } else chunks.push(c) })
    req.on('end', async () => {
      if (aborted) return sendJson(res, { error: 'file too large' }, 413)
      try {
        ignoredDir(dir)
        await writeFile(join(dir, safe), Buffer.concat(chunks))
        sendJson(res, { ok: true, path: join('.jeeves-uploads', safe) })
      } catch (e) { sendJson(res, { error: e.message }, 500) }
    })
    req.on('error', () => { if (!res.headersSent) sendJson(res, { error: 'upload failed' }, 500) })
    return
  }
  // Reveal a space's folder in the OS: an editor (VS Code) or the file manager
  // (Finder / Explorer / xdg-open). Loopback + token gated + cwd-allowlisted.
  if (req.method === 'POST' && path === '/api/open') {
    const body = await readBody(req)
    const cwd = body.cwd
    if (!cwd || !allowedCwd(cwd)) return sendJson(res, { error: 'cwd not allowed' }, 400)
    const out = openInOs(cwd, body.target === 'editor' ? 'editor' : 'files')
    return sendJson(res, out, out.error ? 400 : 200)
  }
  if (req.method === 'DELETE' && path === '/api/session') {
    const sid = url.searchParams.get('sid')
    const s = sid && sessions.get(sid)
    if (s) { try { s.term.kill() } catch {}; sessions.delete(sid) }
    if (sid) { sessionStatus.delete(sid); if (tabSessions.delete(sid)) saveTabs() } // drop the persisted resume record too
    return sendJson(res, { ok: true })
  }
  if (path === '/api/worktrees') {
    const repo = REPOS.find((r) => r.id === url.searchParams.get('repoId'))
    if (!repo) return sendJson(res, { error: 'unknown repo' }, 400)
    const worktrees = await listWorktrees(repo)
    for (const w of worktrees) dynRoots.add(normalize(w.path))
    return sendJson(res, { worktrees })
  }
  if (path === '/api/branches') {
    const repo = REPOS.find((r) => r.id === url.searchParams.get('repoId'))
    if (!repo) return sendJson(res, { error: 'unknown repo' }, 400)
    return sendJson(res, await listBranches(repo))
  }
  if (path === '/api/prs') {
    const repo = REPOS.find((r) => r.id === url.searchParams.get('repoId'))
    if (!repo) return sendJson(res, { error: 'unknown repo' }, 400)
    return sendJson(res, await listPRs(repo))
  }
  // One PR's description + headline stats, for expanding a dashboard row.
  if (path === '/api/prview') {
    const repo = REPOS.find((r) => r.id === url.searchParams.get('repoId'))
    const num = (url.searchParams.get('number') || '').replace(/^#/, '')
    if (!repo || !/^\d+$/.test(num)) return sendJson(res, { error: 'repo and number required' }, 400)
    return sendJson(res, await prView(repo, num))
  }
  if (req.method === 'POST' && path === '/api/worktree') {
    const body = await readBody(req)
    const repo = REPOS.find((r) => r.id === body.repoId)
    if (!repo || !body.branch) return sendJson(res, { error: 'repo and branch required' }, 400)
    const out = await createWorktree(repo, String(body.branch))
    if (out.path) dynRoots.add(normalize(out.path))
    return sendJson(res, out, out.error ? 400 : 200)
  }
  if (req.method === 'DELETE' && path === '/api/worktree') {
    const repo = REPOS.find((r) => r.id === url.searchParams.get('repoId'))
    const wt = url.searchParams.get('path')
    if (!repo || !wt || !allowedCwd(wt)) return sendJson(res, { error: 'bad request' }, 400)
    const out = await removeWorktree(repo, wt, url.searchParams.get('force') === '1')
    return sendJson(res, out, out.error ? 400 : 200)
  }
  // Config (defaults.md, identity.md, each project.md + its ledger) for the Settings
  // modal. GET = configView(); POST { file, project?, set, unset } edits one file
  // in place (writeConfig) and answers with the fresh view.
  if (path === '/api/settings/config') {
    if (req.method !== 'POST') return sendJson(res, configView())
    const out = await writeConfig(await readBody(req))
    return out.error ? sendJson(res, out, 400) : sendJson(res, configView())
  }
  // Global Jeeves settings: the loop-constraints.md the user layers on the shipped
  // baseline, cockpit.json, and the cockpit's address. POST carries one of
  // { loopConstraints } | { cockpit: { set, unset } } | { rotateToken: true } and
  // answers with the fresh view (plus the new token after a rotation).
  if (path === '/api/settings') {
    if (req.method === 'POST') {
      const body = await readBody(req)
      let out = {}
      if (typeof body.loopConstraints === 'string') {
        try { await writeFile(join(NEUTRAL, 'loop-constraints.md'), body.loopConstraints) }
        catch (e) { out = { error: 'write failed: ' + e.message } }
      } else if (body.cockpit) out = await writeCockpit(body.cockpit)
      else if (body.rotateToken === true) out = await rotateToken()
      else out = { error: 'loopConstraints, cockpit or rotateToken required' }
      if (out.error) return sendJson(res, out, 400)
      return sendJson(res, { ...settingsView(), ...(out.token ? { token: out.token } : {}) })
    }
    return sendJson(res, settingsView())
  }
  // Built-in and user agents for Settings → Agents; POST applies one editAgents op and answers with the fresh view.
  if (path === '/api/agents') {
    if (req.method !== 'POST') return sendJson(res, agentsView())
    const out = await editAgents(await readBody(req))
    return out.error ? sendJson(res, out, 400) : sendJson(res, agentsView())
  }
  // reminders.md rows for Settings; POST applies one editReminders op and answers with the fresh list.
  if (path === '/api/reminders') {
    if (req.method !== 'POST') return sendJson(res, remindersView())
    const out = await editReminders(await readBody(req))
    return out.error ? sendJson(res, out, 400) : sendJson(res, remindersView())
  }

  // ── Static (built app). In dev, Vite serves the UI and proxies /pty + /api here. ──
  if (!existsSync(DIST)) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Jeeves Cockpit backend is up. In dev: npm run dev → http://localhost:5173')
    return
  }
  const rel = path === '/' ? 'index.html' : normalize(path).replace(/^(\.\.[/\\])+/, '').replace(/^\//, '')
  try {
    const buf = await readFile(join(DIST, rel))
    res.writeHead(200, { 'content-type': CT[extname(rel)] || 'application/octet-stream' })
    res.end(buf)
  } catch {
    try {
      res.writeHead(200, { 'content-type': CT['.html'] })
      res.end(await readFile(join(DIST, 'index.html')))
    } catch { res.writeHead(404); res.end('not found') }
  }
})

// ── PTY over WebSocket ───────────────────────────────────────────────────────
// ── PTY session registry ─────────────────────────────────────────────────────
// Keyed by a stable client id (space:tab). A dropped socket detaches but keeps
// the PTY alive so a UI reload can re-attach; sessions die on explicit close
// (DELETE /api/session), on process exit, or after too long detached.
const sessions = new Map()
const MAX_BUF = 256 * 1024
const MAX_UPLOAD = 25 * 1024 * 1024 // cap dropped-file size

// Per-session Claude Code hooks that POST lifecycle transitions to /api/hook, so
// dots reflect real activity (working ↔ awaiting ↔ idle ↔ offline) rather than only
// the semantic done/blocked the `report` tool sets. `--settings` ADDS to the user's
// own hooks — it never replaces them.
const HOOK_SCRIPT = join(__dirname, 'bin', 'hook.mjs')
// The browser's colour scheme (sent on every pane connect and on toggle). Claude
// sessions launched from here get the matching variant of the user's theme, so
// dark-ansi becomes light-ansi in a light UI, dark ↔ light, and so on.
let uiScheme = 'dark'
let _themeVariant
function claudeTheme() {
  if (_themeVariant === undefined) {
    _themeVariant = ''
    try { _themeVariant = String(JSON.parse(readFileSync(join(os.homedir(), '.claude', 'settings.json'), 'utf8')).theme || '').replace(/^(dark|light)/, '') } catch {}
  }
  return uiScheme + _themeVariant
}

// Per-session --settings for every claude the cockpit launches: lifecycle hooks
// keyed by id (so its dot reflects working / awaiting / idle) and the UI-matched theme.
function sessionSettings(id) {
  const url = `http://${HOST}:${PORT}/api/hook?token=${encodeURIComponent(SESSION_TOKEN)}`
  // A Node helper (not curl + POSIX redirection) so hooks fire the same on macOS,
  // Linux and Windows. process.execPath is the running node binary.
  const post = (status) => ({ hooks: [{ type: 'command', command: `"${process.execPath}" "${HOOK_SCRIPT}" "${id}" "${status}" "${url}"` }] })
  return JSON.stringify({ theme: claudeTheme(), hooks: {
    SessionStart: [post('working')],
    UserPromptSubmit: [post('working')],
    Notification: [post('awaiting')],
    Stop: [post('idle')],
    SessionEnd: [post('offline')]
  } })
}

// Hook lifecycle states compose with the semantic ones from `report`. A report's
// outcome (done/blocked/error) is authoritative and STICKS: a lifecycle hook must
// never overwrite it — not even 'working' from the SessionStart/UserPromptSubmit
// that fires when a finished worker is resumed after a server restart (that was
// silently flipping a reported 'done' back to 'working'). Only a fresh report
// moves a worker off a semantic terminal.
function applyHookStatus(cur, next) {
  if (cur === 'done' || cur === 'blocked' || cur === 'error') return cur // semantic terminal — hooks can't touch it
  if (next === 'offline') return 'exited'
  if (next === 'working') return 'working'              // new/resumed session or new turn — always live
  if (cur === 'exited') return cur                      // dead session: ignore a stale idle/awaiting
  return next                                           // idle | awaiting on a live session
}

// The system-prompt appendix every dispatched worker carries — how to report
// back over the bus. Shared by the initial dispatch and a post-restart resume.
function workerPreamble(workId) {
  return `You are a Jeeves worker running inside the cockpit, in an isolated git worktree. Your workId is "${workId}". You cannot post to GitHub on the loop's behalf; open your own PR only. When the task is complete or you are blocked, report in THREE steps, IN THIS ORDER: (1) ALWAYS FIRST write your FULL result to a file "JEEVES_REPORT.md" at the ROOT of your worktree — a fenced JSON block with { workId: "${workId}", status: "done"|"blocked"|"error", summary, pr, verdict, threads } followed by the substance in prose. Write this EVERY time, not only on failure: it is the durable record the loop falls back to, and it survives a cockpit restart when nothing else does. (2) Call the MCP tool "report" (server "cockpit") with { workId: "${workId}", status, summary, pr, verdict, threads }. If it errors (e.g. cockpit MCP down / ConnectionRefused), retry it at most ONCE — do not thrash; JEEVES_REPORT.md from step 1 already covers you. (3) Send ONE cross-session message to the session named "${ORCH_NAME}" (SendMessage, to: "${ORCH_NAME}") carrying the FULL result (not just a one-liner), so it can act immediately even if the report call was refused. Do not resend it in a loop — one message, then finish. The orchestrator sees your work through the report, the message, or JEEVES_REPORT.md — never through printed terminal text.`
}

// The orchestrator is a real `claude` booting the Jeeves loop, wired to this
// process's MCP server and given a known session id so we can read its context.
function fileArgsFor(kind, sid, cwd, prompt) {
  // Order matters: --mcp-config is variadic, so it must be followed by another
  // flag (not the positional prompt) or it swallows the prompt as a config path.
  if (kind === 'orch') {
    // Reusing a session id errors ("already in use"), so on any respawn (crash,
    // reaper, reopened pane) resume once the transcript exists. Every launch takes
    // the configured model + effort.
    const idArgs = existsSync(orchTranscriptPath()) ? ['--resume', ORCH_SESSION_ID] : ['--session-id', ORCH_SESSION_ID]
    return { file: 'claude', args: ['--mcp-config', MCP_CONFIG_FILE, ...idArgs, '--model', cfg('orchModel'), '--effort', cfg('orchEffort'), '--settings', sessionSettings('orch:main'), '--permission-mode', cfg('orchPermission'), '--name', ORCH_NAME, '/jeeves:start'] }
  }
  // A dispatched worker respawned after a restart: resume its persisted session so
  // its conversation (and MCP wiring) come back, rather than a blank shell — as the
  // same agent and on the same model it was dispatched with.
  if (kind === 'worker') {
    const w = workerList().find((x) => x.sid === sid)
    if (w?.sessionId && existsSync(transcriptPathFor(w.cwd, w.sessionId))) {
      const def = findAgent(w.agent)
      return { file: 'claude', args: ['--mcp-config', mcpConfig('worker', sid), '--resume', w.sessionId, ...(w.model ? ['--model', w.model] : []), '--permission-mode', cfg('workerPermission'), '--settings', sessionSettings(w.workId), ...(def ? agentArgs(def) : []), '--append-system-prompt', workerPreamble(w.workId)] }
    }
    return { file: SHELL, args: [] } // nothing to resume (record/transcript gone)
  }
  // A user-opened claude tab gets the same lifecycle hooks, keyed by its sid, so
  // its space's sidebar dot reflects working / awaiting / idle, and the child-tab
  // MCP tools. It also gets a stable session id (persisted) so it resumes after a
  // server restart. shell + codex are not Claude, so no hooks fire and there's
  // nothing to resume. A tab opened by open_tab starts on its `prompt`.
  if (kind === 'claude') {
    if (!sid) return { file: 'claude', args: [] }
    let rec = tabSessions.get(sid)
    if (!rec) { rec = { sessionId: randomUUID(), cwd: cwd || NEUTRAL }; tabSessions.set(sid, rec); saveTabs() }
    const idArgs = existsSync(transcriptPathFor(rec.cwd, rec.sessionId)) ? ['--resume', rec.sessionId] : ['--session-id', rec.sessionId]
    return { file: 'claude', args: ['--mcp-config', mcpConfig('tab', sid), ...idArgs, '--settings', sessionSettings(sid), ...(prompt ? [prompt] : [])] }
  }
  if (kind === 'codex') return { file: 'codex', args: prompt ? [prompt] : [] }
  return { file: SHELL, args: [] }
}

// Spawn a PTY and register it under sid. Throws on spawn failure so callers
// decide how to surface it (a socket gets a message; dispatch gets an error).
// PTYs inherit the server's env. If the server was launched from macOS Terminal,
// that env carries TERM_PROGRAM=Apple_Terminal, which makes zsh source
// /etc/zshrc_Apple_Terminal and print "Restored session:" into every new shell.
// These panes are xterm.js, not Apple Terminal, so strip that machinery.
const PTY_ENV = (() => {
  const e = { ...process.env, TERM_PROGRAM: 'jeeves-cockpit', SHELL_SESSIONS_DISABLE: '1' }
  delete e.TERM_SESSION_ID
  return e
})()

// node-pty on Windows looks a bare name up on PATH without PATHEXT, so `claude`
// finds npm's extensionless sh shim and CreateProcess fails (error code 2). Resolve
// a bare name with where.exe instead: the .exe if there is one, else the exe an npm
// .cmd shim points at, else the shim through cmd.exe (which re-parses arguments, so
// a multi-line --append-system-prompt may not survive). Cached per name.
const _winBin = new Map()
function winSpawnTarget(file, args) {
  if (!WIN || /[\\/.]/.test(file)) return [file, args]
  if (!_winBin.has(file)) {
    let hits = []
    try { hits = execFileSync('where.exe', [file], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).filter(Boolean) } catch {}
    let hit = hits.find((h) => /\.exe$/i.test(h)) || null
    const shim = hit ? null : hits.find((h) => /\.(cmd|bat)$/i.test(h))
    if (shim) {
      const m = readFileSync(shim, 'utf8').match(/"%dp0%\\([^"]+\.exe)"/i)
      const exe = m && join(dirname(shim), m[1])
      hit = exe && existsSync(exe) ? exe : shim
      if (hit === shim) console.error(`cockpit: running ${file} through cmd.exe (${shim}); multi-line arguments may break`)
    }
    _winBin.set(file, hit)
  }
  const hit = _winBin.get(file)
  if (!hit) return [file, args]
  return /\.exe$/i.test(hit) ? [hit, args] : [process.env.ComSpec || 'cmd.exe', ['/d', '/c', hit, ...args]]
}

function spawnSession(sid, cwd, file, args, kind) {
  ;[file, args] = winSpawnTarget(file, args)
  const term = pty.spawn(file, args, { name: 'xterm-256color', cols: 80, rows: 24, cwd, env: PTY_ENV })
  const sess = { term, buf: '', clients: new Set(), detachedAt: 0, kind: kind || 'shell' }
  const broadcast = (o) => { const msg = JSON.stringify(o); for (const c of sess.clients) if (c.readyState === 1) { try { c.send(msg) } catch {} } }
  sessions.set(sid, sess)
  if (sessionStatus.get(sid) === 'exited') { sessionStatus.set(sid, 'working'); pushSessionStatus(sid, 'working') } // respawned
  term.onData((d) => {
    sess.buf += d
    if (sess.buf.length > MAX_BUF) sess.buf = sess.buf.slice(sess.buf.length - MAX_BUF)
    broadcast({ t: 'o', d })
  })
  term.onExit(({ exitCode }) => {
    broadcast({ t: 'exit', code: exitCode })
    // Only drop the registry entry if it is still this PTY: after a kill, a reattach
    // can spawn a replacement under the same sid before this exit fires.
    const own = sessions.get(sid) === sess // false once closeWork/kill dropped it first
    if (own) sessions.delete(sid)
    const w = [...bus.workers.values()].find((x) => x.sid === sid)
    if (w && !['done', 'blocked', 'error'].includes(w.status)) { w.status = exitCode ? 'error' : 'exited'; w.updatedAt = Date.now(); saveWorkers(); pushSpaces() }
    // Worker hooks post under the workId, so a worker's sid only enters sessionStatus
    // here — the UI's "it ended on its own" signal, so never for a deliberate close.
    if ((w && own) || sessionStatus.has(sid)) { sessionStatus.set(sid, 'exited'); pushSessionStatus(sid, 'exited') }
  })
  return sess
}

function attach(ws, sid, cwd, kind) {
  let sess = sessions.get(sid)
  if (!sess) {
    // The first attach of a tab open_tab created binds it and starts it on its prompt.
    const link = tabLinks.get(sid.split(':')[1])
    const launch = link && !link.sid && link.kind === kind ? link : null
    if (launch) launch.sid = sid
    const { file, args } = fileArgsFor(kind, sid, cwd, launch?.prompt)
    try { sess = spawnSession(sid, cwd, file, args, kind) }
    catch (err) {
      try { ws.send(JSON.stringify({ t: 'o', d: `\r\n[cockpit: failed to spawn ${file} — ${err.message}]\r\n` })) } catch {}
      return ws.close()
    }
  }

  // Every pane attached to the session (another browser tab, the phone) gets the
  // output; input and resizes from any of them reach the PTY.
  sess.clients.add(ws)
  sess.detachedAt = 0
  if (sess.buf) { try { ws.send(JSON.stringify({ t: 'o', d: sess.buf })) } catch {} } // replay scrollback

  // The replayed buffer is a full-screen TUI's output recorded at earlier sizes, so
  // it lands scrambled. The client's size usually matches the PTY's already, and a
  // same-size resize raises no SIGWINCH, so claude never repaints. On the first
  // resize after attach, narrow a claude pane by one column and restore it: a real
  // width change makes claude clear and redraw the whole frame.
  let redrawn = sess.kind === 'shell' || sess.kind === 'codex'
  ws.on('message', (raw) => {
    let m
    try { m = JSON.parse(raw) } catch { return }
    if (m.t === 'i') sess.term.write(m.d)
    else if (m.t === 'r' && m.cols > 0 && m.rows > 0) {
      sess.size = { cols: m.cols, rows: m.rows }
      if (!redrawn && m.cols > 1) {
        redrawn = true
        try { sess.term.resize(m.cols - 1, m.rows) } catch {}
        setTimeout(() => { try { sess.term.resize(sess.size.cols, sess.size.rows) } catch {} }, 80)
      } else { try { sess.term.resize(m.cols, m.rows) } catch {} }
    }
    else if (m.t === 'kill') { try { sess.term.kill() } catch {}; sessions.delete(sid) }
    else if (m.t === 'scheme' && (m.v === 'light' || m.v === 'dark')) uiScheme = m.v
  })
  ws.on('close', () => { sess.clients.delete(ws); if (!sess.clients.size) sess.detachedAt = Date.now() })
}

// Resolve a repo tag (id, owner/name slug, or bare name) to its configured repo.
const findRepo = (tag) => tag ? REPOS.find((r) => r.id === tag || r.slug === tag || basename(r.slug) === tag || r.slug.endsWith('/' + tag)) : undefined

// Dispatch: create a worktree, spawn a separate `claude` worker as its own
// visible space, and track it. An `agent` naming an agent file runs the session as
// that agent; any other value is a label and the prompt carries the role. Either
// way we append the workId + how to report back over the bus.
async function dispatch({ agent, repo, ticket, branch, prompt, model }) {
  const r = findRepo(repo)
  if (!r) return { error: 'unknown repo: ' + repo }
  // Name the worktree/branch after the agent when the caller gives no explicit
  // branch, so a planner's scratch worktree is obviously a planner's, not just
  // the ticket. Story-workers pass their real branch, so it's used as-is.
  const br = String(branch || (ticket ? `${agent || 'work'}-${ticket}` : `${agent || 'work'}-${Date.now().toString(36)}`))
  const wt = await createWorktree(r, br)
  if (wt.error) return { error: wt.error }
  dynRoots.add(normalize(wt.path))
  const workId = 'w' + randomBytes(3).toString('hex')
  const sid = 'work:' + workId
  const sessionId = randomUUID() // persisted, so the worker resumes after a server restart
  const def = findAgent(agent)
  const wmodel = workerModelFor(def, model)
  const args = ['--session-id', sessionId, '--mcp-config', mcpConfig('worker', sid), '--model', wmodel, '--permission-mode', cfg('workerPermission'), '--settings', sessionSettings(workId), ...(def ? agentArgs(def) : []), '--append-system-prompt', workerPreamble(workId), String(prompt || 'Begin your assigned task.')]
  try { spawnSession(sid, wt.path, 'claude', args, 'worker') }
  catch (err) {
    // Don't leave the just-created worktree orphaned (no bus entry → uncloseable).
    dynRoots.delete(normalize(wt.path))
    await removeWorktree(r, wt.path, true)
    return { error: 'spawn failed: ' + err.message }
  }
  const rec = { workId, sid, sessionId, agent: agent || 'worker', model: wmodel, repo: r.id, repoSlug: r.slug, ticket: ticket || null, branch: br, cwd: wt.path, status: 'working', summary: null, pr: null, createdAt: Date.now(), updatedAt: Date.now() }
  bus.workers.set(workId, rec)
  saveWorkers()
  pushSpaces()
  return { workId, sid, cwd: wt.path, branch: br }
}

// Close a dispatched worker: end its session, optionally remove its worktree,
// drop it from the bus. Removing a worktree leaves any pushed branch/PR intact.
async function closeWork(workId, { removeWorktree: rm, force } = {}) {
  const w = bus.workers.get(workId)
  if (!w) return { error: 'unknown workId' }
  const s = sessions.get(w.sid)
  if (s) { try { s.term.kill() } catch {}; sessions.delete(w.sid) }
  if (rm) {
    const repo = REPOS.find((r) => r.id === w.repo)
    if (repo) {
      const r = await removeWorktree(repo, w.cwd, !!force)
      if (r.error) { w.status = 'exited'; saveWorkers(); pushSpaces(); return { error: r.error } } // e.g. dirty — keep the entry so the user can force
    }
  }
  bus.workers.delete(workId)
  saveWorkers()
  pushSpaces()
  return { ok: true }
}

// Restart the orchestrator: kill its process and launch a fresh one on a new
// session, so it picks up the configured model, effort and permission mode and any
// plugin, agent or settings change. Durable truth lives in state.md, so this loses
// nothing. Attached panes are closed first (so they never see an exit and give up)
// and reconnect to the new session.
function restartOrchestrator() {
  const old = sessions.get('orch:main')
  if (!old) return { error: 'orchestrator not running' }
  for (const ws of old.clients) { try { ws.close() } catch {} }
  old.clients.clear()
  sessions.delete('orch:main')
  try { old.term.kill() } catch {}
  setOrchSessionId(randomUUID())
  orchStatus = 'working'; orchIdleSince = 0; lastCompactAt = 0
  lastContext = { ...lastContext, pct: null, used: 0, sessionId: ORCH_SESSION_ID, status: orchStatus, updatedAt: Date.now() }
  pushContext()
  const { file, args } = fileArgsFor('orch', 'orch:main', NEUTRAL)
  try { spawnSession('orch:main', NEUTRAL, file, args, 'orch') } catch (err) { return { error: 'spawn failed: ' + err.message } }
  return { ok: true }
}

// Auto-compact: once the orchestrator has sat idle between ticks for a while, no
// dispatched worker is still running (a report it's waiting on could land mid-
// compact) and context is at or above compactPct, type /compact. Claude takes a
// burst of input as a paste, so Enter goes separately.
const COMPACT_IDLE_MS = 2 * 60e3, COMPACT_COOLDOWN_MS = 10 * 60e3
let orchIdleSince = 0, lastCompactAt = 0
const COMPACT_FOCUS = 'Keep: you are the Jeeves orchestrator running a self-paced /loop; the BRIEF rules; every open ticket, PR and dispatched worker with its status; anything waiting on the user. On the next tick, re-read BRIEF.md and state.md.'
setInterval(() => {
  const pct = cfg('compactPct'), sess = sessions.get('orch:main')
  if (!pct || !sess || orchStatus !== 'idle' || !orchIdleSince) return
  const now = Date.now()
  if (now - orchIdleSince < COMPACT_IDLE_MS || now - lastCompactAt < COMPACT_COOLDOWN_MS) return
  if ((readOrchContext().pct ?? 0) < pct) return
  if (workerList().some((w) => !['done', 'blocked', 'error', 'exited'].includes(w.status))) return
  lastCompactAt = now
  try { sess.term.write('/compact ' + COMPACT_FOCUS); setTimeout(() => { try { sess.term.write('\r') } catch {} }, 150) } catch {}
}, 30e3).unref()

// ── Dashboard surface merge ──────────────────────────────────────────────────
// Row identity: "<repo>#<number>" for PR sections, "<repo>:<KEY>" for Jira ones,
// with the repo tag normalised to its repo id so any spelling of it matches.
const ROW_SECTIONS = ['stories', 'myPrs', 'qa', 'reviews']
const PR_SECTIONS = new Set(['myPrs', 'reviews'])
const repoKey = (tag) => (tag ? findRepo(tag)?.id ?? String(tag) : '')
function rowId(section, row) {
  const repo = repoKey(row.repo)
  if (PR_SECTIONS.has(section)) {
    const n = (row.number != null && String(row.number).replace(/^#/, '').trim()) || row.item?.match(/^\s*#(\d+)/)?.[1]
    return n ? `${repo}#${n}` : null
  }
  const k = row.key?.trim() || row.item?.match(/^\s*([A-Z][A-Z0-9]*-\d+)/)?.[1]
  return k ? `${repo}:${k}` : null
}
// A remove id as the orchestrator wrote it ("acme/web#1914") → canonical
// form. A bare number or key with no separator is taken as untagged.
function normaliseId(section, id) {
  const sep = PR_SECTIONS.has(section) ? '#' : ':'
  const s = String(id).trim(), at = s.lastIndexOf(sep)
  return at < 0 ? sep + s : repoKey(s.slice(0, at)) + sep + s.slice(at + 1).trim()
}

// Apply one surface_render call to the current surface: full sections replace
// whole, then upserts replace-or-append by identity, then removes delete by
// identity. Returns the next surface and a summary line for the tool result.
function mergeSurface(prev, { upsert, remove, ...full }) {
  const next = { ...(prev || {}), ...full, updatedAt: Date.now() }
  const rejected = [], missing = []
  const counts = ROW_SECTIONS.map((sec) => {
    const ups = upsert?.[sec] ?? [], rms = remove?.[sec] ?? []
    if (!ups.length && !rms.length) return `${sec} ${(next[sec] ?? []).length}`
    const rows = [...(next[sec] ?? [])]
    let upserted = 0, removed = 0
    ups.forEach((row, i) => {
      const id = rowId(sec, row)
      if (!id) { rejected.push(`${sec}[${i}] (no ${PR_SECTIONS.has(sec) ? '#number' : 'Jira key'})`); return }
      const at = rows.findIndex((r) => rowId(sec, r) === id)
      if (at < 0) rows.push(row); else rows[at] = row
      upserted++
    })
    for (const raw of rms) {
      const id = normaliseId(sec, raw)
      const at = rows.findIndex((r) => rowId(sec, r) === id)
      if (at < 0) { missing.push(`${sec} ${raw}`); continue }
      rows.splice(at, 1); removed++
    }
    next[sec] = rows
    const delta = [upserted && `${upserted} upserted`, removed && `${removed} removed`].filter(Boolean).join(', ')
    return `${sec} ${rows.length}${delta ? ` (${delta})` : ''}`
  })
  const text = 'surface updated — ' + counts.join(', ')
    + (rejected.length ? '; rejected: ' + rejected.join(', ') : '')
    + (missing.length ? '; not found: ' + missing.join(', ') : '')
  return { surface: next, text }
}

// ── MCP server (one per transport/session) ───────────────────────────────────
const dot = z.enum(['red', 'yellow', 'green', 'white'])
// The orchestrator (no role) → the full tool set. role 'worker' → `report` plus
// the child-tab tools; role 'tab' → the child-tab tools only. `caller` is the
// worker's or tab's sid, from its inline MCP config.
function buildMcpServer(role, caller) {
  const srv = new McpServer({ name: 'jeeves-cockpit', version: '2.0.0' })
  const full = !role

  // An action is a launcher chip the user can fire from a row (sent to this loop's
  // composer). run = the exact reply; type:true types it without submitting (for
  // ones the user should edit first, e.g. "change ABC-5830: ...").
  const action = z.object({
    label: z.string().describe('Short menu label, e.g. "Plan", "Resolve", "Approve", "Test", "View plan".'),
    run: z.string().optional().describe('Exact launcher reply, e.g. "plan ABC-5830", "review 1860", "qa 3". Omit for a link action.'),
    type: z.boolean().optional().describe('True = type into the composer without submitting, for a reply the user must complete first.'),
    href: z.string().optional().describe('A URL to OPEN IN A NEW TAB instead of running a launcher — e.g. a published plan\'s Confluence link on a Story row. Set href OR run, not both.')
  })
  // Row schemas, shared by the full-section and `upsert` forms of surface_render.
  const rowSchemas = {
    stories: z.object({
      item: z.string().describe('Story/ticket summary. Lead with the Jira key (e.g. "ABC-5830 — add X") so it links.'),
      key: z.string().optional().describe('Jira key, for linking (if not already in item).'),
      status: z.string().optional().describe('Real Jira status for the row badge, e.g. "To Do" / "Stage Test" / "Ready For QA". Set it on EVERY sprint ticket so the whole sprint shows where each one is.'),
      phase: z.enum(['needs-plan', 'planning', 'awaiting-approval', 'approved', 'in-progress', 'in-review', 'blocked', 'done']).optional().describe('Only for a ticket in the plan→approve→implement→review flow; drives the plan-flow badge + actions.'),
      dot: dot.optional(), repo: z.string().optional(),
      next: z.string().optional().describe('One-line next step, if not obvious from the item.'),
      actions: z.array(action).optional().describe('e.g. [{label:"Plan",run:"plan ABC-5830"}] for needs-plan; [{label:"Approve",run:"approve ABC-5830"},{label:"Change",run:"change ABC-5830: ",type:true}] for awaiting-approval.')
    }),
    myPrs: z.object({
      item: z.string().describe('PR summary. Lead with "#<number>" so it links to GitHub.'),
      number: z.union([z.string(), z.number()]).optional(),
      checks: z.enum(['pass', 'fail', 'pending']).optional().describe('CI state: pass/fail/pending.'),
      state: z.string().optional().describe('e.g. "open", "draft", "changes requested", "approved".'),
      dot: dot.optional(), repo: z.string().optional(), next: z.string().optional(),
      actions: z.array(action).optional().describe('e.g. [{label:"Resolve",run:"resolve 1857"}] when changes are requested.')
    }),
    qa: z.object({
      item: z.string().describe('Ticket to QA. Lead with the Jira key so it links.'),
      key: z.string().optional(), priority: z.string().optional().describe('Jira priority, e.g. "Highest".'),
      dot: dot.optional(), repo: z.string().optional(),
      actions: z.array(action).optional().describe('Default [{label:"Test",run:"qa <n>"}] — qa <n> prints its testing instructions.')
    }),
    reviews: z.object({
      item: z.string().describe('Teammate PR to review. Lead with "#<number>".'),
      number: z.union([z.string(), z.number()]).optional(),
      author: z.string().optional().describe('PR owner\'s GitHub login — shown as "by <author>".'),
      checks: z.enum(['pass', 'fail', 'pending']).optional(), state: z.string().optional(),
      dot: dot.optional(), repo: z.string().optional(), next: z.string().optional(),
      actions: z.array(action).optional().describe('e.g. [{label:"Review",run:"review 1860"}]; after a review is drafted, [{label:"Comment",run:"comment 1860"},{label:"Approve",run:"approve 1860"},{label:"Request changes",run:"request-changes 1860"}].')
    })
  }
  const perSection = (f) => z.object(Object.fromEntries(ROW_SECTIONS.map((k) => [k, f(k).optional()])))
  if (full) srv.registerTool('surface_render', {
    description: 'Paint the cockpit right-pane dashboard: four row sections — stories, myPrs, qa, reviews — plus optional inFlight and a quiet line. Three ways to change it, applied in this order within one call:\n'
      + '1. **Full section** (`stories: [...]` etc.): replaces that section WHOLE — send every current row. [] clears it; an omitted section is left unchanged. inFlight and quiet are only ever full-replace.\n'
      + '2. **`upsert: { <section>: [rows] }`**: each row replaces the existing row with the same identity, or is appended; other rows are untouched.\n'
      + '3. **`remove: { <section>: [ids] }`**: deletes the rows with those identities.\n'
      + 'Identity: myPrs/reviews = "<repo>#<number>" (from `number`, else the leading #NNN of `item`); stories/qa = "<repo>:<KEY>" (from `key`, else the leading Jira key of `item`). <repo> is the row\'s repo tag — id, owner/name and bare name all match — or empty when untagged, e.g. "fuse_sdk#1914", ":ABC-5940". An upsert row with no derivable identity is rejected; the result gives per-section row counts and lists rejected rows and remove ids that matched nothing — check it.\n'
      + '`reminders` (full-replace only) renders above every other section: send every reminder due now (dot red) or within the next 24h (no dot), with Done / Snooze actions; [] once none are pending.\n'
      + 'Send full sections on the first paint of a session or after a restart; after that, send only changes via upsert/remove. Repo-tag rows when more than one project is loaded. Give each row an `actions` list so the user can act with one click.',
    inputSchema: {
      quiet: z.string().optional().describe('One-line quiet-tick summary when nothing needs the user.'),
      reminders: z.array(z.object({
        id: z.string().describe('The reminder id from reminders.md.'),
        item: z.string().describe('What to be reminded of.'),
        due: z.string().optional().describe('When it is due, as the user would say it, e.g. "today 15:00" or "overdue 20m".'),
        dot: dot.optional(),
        actions: z.array(action).optional().describe('e.g. [{label:"Done",run:"done r3"},{label:"Snooze 1h",run:"snooze r3 1h"}].')
      })).optional(),
      stories: z.array(rowSchemas.stories).optional(),
      myPrs: z.array(rowSchemas.myPrs).optional(),
      qa: z.array(rowSchemas.qa).optional(),
      reviews: z.array(rowSchemas.reviews).optional(),
      inFlight: z.array(z.object({ text: z.string(), repo: z.string().optional() })).optional(),
      upsert: perSection((k) => z.array(rowSchemas[k])).optional().describe('Rows to replace-or-append by identity, per section.'),
      remove: perSection(() => z.array(z.string())).optional().describe('Row identities to delete, per section, e.g. { myPrs: ["web#1914"] }.')
    }
  }, async (payload) => {
    const { surface, text } = mergeSurface(bus.surface, payload)
    bus.surface = surface
    pushSurface()
    return { content: [{ type: 'text', text }] }
  })

  // The agent roster, read per MCP session so a new or edited agent shows up.
  const { builtin, custom } = agentsView()
  const roster = [
    ...builtin.map((a) => `- ${a.name}${a.override ? ' (customised)' : ''} — ${(a.override || a).description}`),
    ...custom.map((a) => `- ${a.name} (custom) — ${a.description}`)
  ].join('\n')
  if (full) srv.registerTool('dispatch', {
    description: 'Dispatch a unit of work to a separate worker session (a new cockpit space) in a fresh worktree. Returns a workId. The worker reports back via the "report" tool; drain results with "inbox".\n'
      + 'When `agent` names one of these agents, the session runs as it (its prompt, tools and model) — the prompt carries only the task:\n'
      + roster + '\n'
      + 'Any other `agent` (e.g. planner, reviewer) is a label: compose the full prompt yourself (role + task).',
    inputSchema: {
      agent: z.string().describe('An agent name from the list above, or a label for the worker.'),
      repo: z.string().describe('Repo id or slug the work belongs to.'),
      prompt: z.string().describe('The task, with its full context; for a label, also the role.'),
      ticket: z.string().optional().describe('Jira key, PR number, or story id, for tracking.'),
      branch: z.string().optional().describe('Branch/worktree name; defaults from ticket. For a reviewer, pass the PR head branch.'),
      model: z.string().optional().describe(`Worker model; defaults to ${cfg('workerModel')} (any opus you pass is pinned to ${workerOpus()}). Use sonnet only for mechanical work. A custom or customised agent with its own model runs on that instead.`)
    }
  }, async (a) => {
    const out = await dispatch(a)
    return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out, isError: !!out.error }
  })

  if (role !== 'tab') srv.registerTool('report', {
    description: 'Report a worker\'s result back to the loop. Call this from a worker session when done or blocked.',
    inputSchema: {
      workId: z.string(),
      status: z.enum(['done', 'blocked', 'error', 'working']).optional(),
      summary: z.string(),
      pr: z.string().optional(),
      verdict: z.string().optional().describe('For a verifier: APPROVE / REJECT / ESCALATE_HUMAN.'),
      threads: z.string().optional().describe('For a resolver: thread-id → disposition map, as text.')
    }
  }, async (rp) => {
    const w = bus.workers.get(rp.workId)
    const entry = { ...rp, at: Date.now() }
    if (w) {
      // The worker record is the DURABLE store (persisted to disk, reloaded on
      // boot), so stash the report on it — not only on the in-memory inbox, which
      // a server restart or a re-dispatch wipes before the orchestrator drains it.
      // `ackedAt: null` marks it un-drained; inbox() reconciles from these records.
      w.status = rp.status || 'done'; w.summary = rp.summary; w.pr = rp.pr || w.pr
      w.report = entry; w.ackedAt = null; w.updatedAt = entry.at
      saveWorkers()
    } else {
      // Orphan report: the worker record is already gone (closed/pruned). Best-effort
      // in-memory only — there's nothing durable left to hang it on.
      bus.inbox.push(entry)
    }
    pushSpaces()
    return { content: [{ type: 'text', text: 'report recorded' }] }
  })

  if (full) srv.registerTool('close_work', {
    description: 'Close a finished worker: end its session and optionally remove its worktree. Close a planner workspace once you have captured/published its plan (removeWorktree: true — planners are scratch). Close a story-worker workspace once its PR has merged (removeWorktree: true — removing the worktree leaves the merged branch/PR intact).',
    inputSchema: {
      workId: z.string(),
      removeWorktree: z.boolean().optional().describe('Delete the git worktree too.'),
      force: z.boolean().optional().describe('Force worktree removal despite uncommitted changes.')
    }
  }, async ({ workId, removeWorktree: rm, force }) => {
    const out = await closeWork(workId, { removeWorktree: rm, force })
    return { content: [{ type: 'text', text: JSON.stringify(out) }], isError: !!out.error }
  })

  if (full) srv.registerTool('write_state', {
    description: "Persist a project's state.md (your per-tick memory), or with file: 'reminders' the data home's reminders.md, by passing the FULL new contents. Use this instead of the Edit/Write tool so the user's terminal isn't filled with state diffs — it writes the file server-side.",
    inputSchema: {
      project: z.string().optional().describe("Project id — the projects/<id> folder name. Required unless file is 'reminders'."),
      file: z.enum(['state', 'reminders']).optional().describe("'state' (default) = projects/<id>/state.md; 'reminders' = <data-home>/reminders.md."),
      markdown: z.string().describe('The complete new contents of the file.')
    }
  }, async ({ project, file, markdown }) => {
    const reminders = file === 'reminders'
    if (!reminders && !REPOS.find((r) => r.id === project)) return { content: [{ type: 'text', text: 'unknown project: ' + project }], isError: true }
    try { await writeFile(reminders ? join(NEUTRAL, 'reminders.md') : join(NEUTRAL, 'projects', project, 'state.md'), String(markdown)) }
    catch (e) { return { content: [{ type: 'text', text: 'write failed: ' + e.message }], isError: true } }
    return { content: [{ type: 'text', text: 'state saved' }] }
  })

  const ok = (text) => ({ content: [{ type: 'text', text }] })
  const bad = (text) => ({ content: [{ type: 'text', text }], isError: true })

  if (full) srv.registerTool('create_project', {
    description: 'Create a new Jeeves project and start tracking it — writes projects/<id>/project.md (identity as prose, settable fields as frontmatter) and adds it live. Give the GitHub slug; path defaults to <devRoot>/<repo name> when omitted. Fails if the id already exists.',
    inputSchema: {
      id: z.string().describe('Project id and folder name, e.g. web. Letters, digits, . _ - only.'),
      repo: z.string().describe('GitHub slug owner/name, e.g. acme/web.'),
      path: z.string().optional().describe('Local checkout path; defaults to <devRoot>/<repo basename>.'),
      baseBranch: z.string().optional().describe('Merge target and diff base, e.g. main or qa.'),
      jiraKey: z.string().optional().describe('Jira project key for ABC-1234 tokens.'),
      reviewCommand: z.string().optional().describe('Command a PR review runs, e.g. /code-review.'),
      seedFiles: z.array(z.string()).optional().describe('Files copied into each new worktree, e.g. [".env"].')
    }
  }, async (a) => {
    const id = String(a.id || '').trim()
    if (!/^[A-Za-z0-9._-]+$/.test(id) || id.startsWith('.')) return bad('invalid project id: ' + a.id)
    const dir = join(NEUTRAL, 'projects', id)
    if (existsSync(join(dir, 'project.md'))) return bad('project already exists: ' + id)
    const prose = [
      `# Project: ${id}`, '',
      '## Identity',
      `- **repo:** \`${a.repo}\``,
      a.baseBranch ? `- **base branch:** \`${a.baseBranch}\`` : null,
      a.path ? `- **path:** \`${a.path}\`` : null,
      a.jiraKey ? `\n## Jira\n- **project key:** \`${a.jiraKey}\`` : null,
      ''
    ].filter((l) => l != null).join('\n')
    const fm = {}
    if (a.reviewCommand) fm.reviewCommand = String(a.reviewCommand).trim()
    if (a.seedFiles?.length) fm.seedFiles = a.seedFiles.map(String).map((s) => s.trim()).filter(Boolean).join(', ')
    try { mkdirSync(dir, { recursive: true }); await writeFile(join(dir, 'project.md'), writeFrontmatter(prose, fm)) }
    catch (e) { return bad('write failed: ' + e.message) }
    const rec = repoFromDir(id)
    if (!rec) return bad('created project.md but it is not usable — check repo/path')
    REPOS.push(rec); addRepoRoots(rec); pushConfig()
    return ok(`created project ${id} (${rec.slug} → ${rec.path})`)
  })

  if (full) srv.registerTool('update_project', {
    description: "Update a project's settable config — review command and worktree seed files. Writes only the frontmatter of project.md; the prose body (your instructions) is left untouched. Omit a field to leave it unchanged; an empty value or one equal to the defaults.md value removes the override so the default is inherited.",
    inputSchema: {
      id: z.string().describe('Project id.'),
      reviewCommand: z.string().optional().describe('New review command; pass an empty string to clear it.'),
      seedFiles: z.array(z.string()).optional().describe('The full new seed-files list (replaces the old one).')
    }
  }, async (a) => {
    const set = {}
    if (a.reviewCommand !== undefined) set.reviewCommand = a.reviewCommand
    if (a.seedFiles !== undefined) set.seedFiles = a.seedFiles
    const out = await writeConfig({ file: 'project', project: a.id, set })
    if (out.error) return bad(out.error + ': ' + a.id)
    return ok(`updated ${a.id}`)
  })

  if (full) srv.registerTool('delete_project', {
    description: 'Stop tracking a project and archive its config folder to projects/.trash (not destroyed). The git checkout and any worktrees are left untouched.',
    inputSchema: { id: z.string().describe('Project id to remove.') }
  }, async ({ id }) => {
    const i = REPOS.findIndex((r) => r.id === id)
    if (i < 0) return bad('unknown project: ' + id)
    const trash = join(NEUTRAL, 'projects', '.trash')
    try { mkdirSync(trash, { recursive: true }); renameSync(join(NEUTRAL, 'projects', id), join(trash, `${id}-${Date.now()}`)) }
    catch (e) { return bad('archive failed: ' + e.message) }
    REPOS.splice(i, 1); pushConfig()
    return ok(`archived project ${id} (moved to projects/.trash)`)
  })

  if (full) srv.registerTool('open_space', {
    description: 'Open a cockpit space for the user — a terminal in a worktree. Give the repo plus ONE of: branch (local or origin; reused if a worktree already has it, else created), pr (its head branch is opened), or path (an existing worktree). Omit all three for the repo\'s main checkout. This is for spaces the USER investigates; dispatched work still goes through dispatch.',
    inputSchema: {
      repo: z.string().describe('Repo id or slug.'),
      branch: z.string().optional().describe('Branch to open — local or an origin branch (checked out into a tracking branch).'),
      pr: z.union([z.string(), z.number()]).optional().describe('PR number; its head branch is opened.'),
      path: z.string().optional().describe('Path of an existing worktree to open directly.'),
      tab: z.enum(['claude', 'shell', 'codex']).optional().describe('Kind of the first tab (default claude).'),
      label: z.string().optional().describe('Display name for the space; defaults to the branch / PR / worktree.')
    }
  }, async (a) => {
    const r = findRepo(a.repo)
    if (!r) return bad('unknown repo: ' + a.repo)
    let cwd, label = a.label
    try {
      if (a.path) {
        const wt = (await listWorktrees(r)).find((w) => normalize(w.path) === normalize(a.path))
        if (!wt) return bad('no worktree of ' + r.id + ' at path: ' + a.path)
        cwd = wt.path; label ||= wt.branch || basename(wt.path)
      } else if (a.pr != null && String(a.pr).trim()) {
        const num = String(a.pr).replace(/^#/, '').trim()
        const pr = ((await listPRs(r)).prs || []).find((p) => String(p.number) === num)
        if (!pr) return bad('open PR not found: ' + a.pr)
        const w = await openBranchWorktree(r, pr.branch); if (w.error) return bad(w.error)
        cwd = w.path; label ||= `#${pr.number}`
      } else if (a.branch) {
        const w = await openBranchWorktree(r, a.branch); if (w.error) return bad(w.error)
        cwd = w.path; label ||= a.branch
      } else {
        cwd = r.path; label ||= r.id
      }
    } catch (e) { return bad('open failed: ' + e.message) }
    // These tools drive the browser over /events; with no tab connected the command
    // is a silent no-op, so refuse rather than hand back a spaceRef that opens nothing.
    if (!hasBrowser()) return bad('no cockpit browser tab is connected — cannot open a space (ask the user to open the cockpit)')
    dynRoots.add(normalize(cwd))
    const spaceRef = 'os' + randomBytes(3).toString('hex')
    broadcast({ t: 'open_space', cmd: { id: spaceRef, repoId: r.id, cwd, label, kind: a.tab || 'claude' } })
    return { content: [{ type: 'text', text: `opening space “${label}” → ${cwd} (spaceRef: ${spaceRef})` }], structuredContent: { spaceRef, cwd, label } }
  })

  if (full) srv.registerTool('add_tab', {
    description: 'Add a tab to a space you already opened with open_space. Pass the spaceRef that open_space returned.',
    inputSchema: {
      spaceRef: z.string().describe('The spaceRef returned by open_space.'),
      tab: z.enum(['claude', 'shell', 'codex']).optional().describe('Kind of the new tab (default claude).')
    }
  }, async ({ spaceRef, tab }) => {
    if (!hasBrowser()) return bad('no cockpit browser tab is connected — cannot add a tab')
    broadcast({ t: 'add_tab', spaceRef, kind: tab || 'claude' })
    return ok(`adding ${tab || 'claude'} tab to ${spaceRef}`)
  })

  if (full) srv.registerTool('close_space', {
    description: 'Close a space you opened with open_space (ends its tabs). Pass the spaceRef that open_space returned. Only closes a space in the browser — it never removes a worktree.',
    inputSchema: { spaceRef: z.string().describe('The spaceRef returned by open_space.') }
  }, async ({ spaceRef }) => {
    if (!hasBrowser()) return bad('no cockpit browser tab is connected — cannot close a space')
    broadcast({ t: 'close_space', spaceRef })
    return ok(`closing ${spaceRef}`)
  })

  // ── Child tabs: a worker or claude tab opens a claude / codex tab in its own
  // worktree, pre-prompted, and waits on the result file the child writes. ──
  const child = (tabRef) => {
    const l = tabLinks.get(tabRef)
    return l && l.parent === caller ? l : null
  }
  const readResult = (l) => { try { return readFileSync(l.result, 'utf8') } catch { return null } }
  const resultAsk = (l) => `When you have finished, write your complete result — findings, verdict, anything you changed — to ${l.result}. The session that opened this tab reads only that file, never your terminal output. Write it once, at the end.`
  if (role === 'tab' || role === 'worker') srv.registerTool('open_tab', {
    description: 'Open a claude or codex tab in YOUR worktree, started on a prompt — a sub-agent the user can watch. Use it to get a second opinion (e.g. a codex review of your changes) or to hand off a side task. The child is told to write its result to a file; call wait_tab with the returned tabRef to get it. The tab opens in your space (a worker\'s opens in a space on its worktree).',
    inputSchema: {
      tab: z.enum(['claude', 'codex']).describe('What the new tab runs.'),
      prompt: z.string().describe('The first message the child gets. Say what to do and what to report; it shares your worktree, so it sees your uncommitted changes.'),
      title: z.string().optional().describe('Tab label, e.g. "codex review".')
    }
  }, async ({ tab, prompt, title }) => {
    if (!hasBrowser()) return bad('no cockpit browser tab is connected — cannot open a tab')
    const tabRef = 't' + randomBytes(3).toString('hex')
    const w = role === 'worker' ? workerList().find((x) => x.sid === caller) : null
    const cwd = role === 'worker' ? w?.cwd : tabSessions.get(caller)?.cwd
    if (!cwd) return bad('cannot place a tab: unknown caller ' + caller)
    const l = { parent: caller, kind: tab, cwd, result: join(ignoredDir(join(cwd, '.jeeves-tabs')), tabRef + '.md'), sid: null }
    l.prompt = `${prompt}\n\n${resultAsk(l)}`
    tabLinks.set(tabRef, l)
    const t = { id: tabRef, kind: tab, title: title || undefined }
    if (w) broadcast({ t: 'add_tab', spaceRef: 'wk-' + w.workId, kind: tab, tab: t, open: { repoId: w.repo, cwd: w.cwd, label: w.ticket || w.branch } })
    else broadcast({ t: 'add_tab', spaceId: caller.split(':')[0], kind: tab, tab: t })
    return { content: [{ type: 'text', text: `opened ${tab} tab ${tabRef}; its result will land in ${l.result} — call wait_tab { tabRef: "${tabRef}" }` }], structuredContent: { tabRef, result: l.result } }
  })

  if (role === 'tab' || role === 'worker') srv.registerTool('wait_tab', {
    description: 'Wait for a tab you opened with open_tab to write its result, and return it. Blocks up to timeoutSec (default 240, max 600); on "pending" just call it again. "exited" means the child ended without writing one.',
    inputSchema: {
      tabRef: z.string().describe('The tabRef open_tab returned.'),
      timeoutSec: z.number().optional().describe('Seconds to wait (default 240, max 600).')
    }
  }, async ({ tabRef, timeoutSec }) => {
    const l = child(tabRef)
    if (!l) return bad('unknown tabRef (or not one you opened): ' + tabRef)
    const end = Date.now() + Math.min(Math.max(+timeoutSec || 240, 5), 600) * 1000
    let lastSize = -1
    for (;;) {
      // Done once the file has held the same non-zero size across two polls, so a
      // result still being written isn't returned half-finished.
      let size = -1; try { size = statSync(l.result).size } catch {}
      if (size > 0 && size === lastSize) return { content: [{ type: 'text', text: readResult(l) }], structuredContent: { status: 'done' } }
      lastSize = size
      if (l.sid && !sessions.has(l.sid)) {
        const text = readResult(l)
        return { content: [{ type: 'text', text: text || `tab ${tabRef} exited without writing ${l.result}` }], structuredContent: { status: text ? 'done' : 'exited' } }
      }
      if (Date.now() >= end) break
      await new Promise((r) => setTimeout(r, 2000))
    }
    const state = !l.sid ? 'not started (its tab has not attached — is the cockpit open?)' : (sessionStatus.get(l.sid) || 'running')
    return { content: [{ type: 'text', text: `pending — tab ${tabRef} is ${state}; call wait_tab again` }], structuredContent: { status: 'pending', state } }
  })

  if (role === 'tab' || role === 'worker') srv.registerTool('send_tab', {
    description: 'Send a follow-up message to a tab you opened with open_tab (e.g. "now check the tests too"). Clears its previous result, so the next wait_tab waits for a fresh one.',
    inputSchema: {
      tabRef: z.string().describe('The tabRef open_tab returned.'),
      text: z.string().describe('The message, submitted as if typed.')
    }
  }, async ({ tabRef, text }) => {
    const l = child(tabRef)
    if (!l) return bad('unknown tabRef (or not one you opened): ' + tabRef)
    const s = l.sid && sessions.get(l.sid)
    if (!s) return bad(`tab ${tabRef} is not running`)
    try { unlinkSync(l.result) } catch {}
    // Bracketed paste keeps a multi-line message from submitting at its first
    // newline; Enter follows once the TUI has taken the paste.
    try { s.term.write(`\x1b[200~${text}\n\n${resultAsk(l)}\x1b[201~`) } catch { return bad('write failed') }
    setTimeout(() => { try { s.term.write('\r') } catch {} }, 150)
    return ok(`sent to ${tabRef} — call wait_tab for its answer`)
  })

  if (full) srv.registerTool('inbox', {
    description: 'Drain pending worker reports (returns them and marks them acknowledged). Call once per tick; then post to GitHub yourself and update state.md. Reports are reconciled from the persisted worker records, so one survives a server restart until you drain it.',
    inputSchema: { peek: z.boolean().optional().describe('Return without acknowledging.') }
  }, async ({ peek }) => {
    // Reconcile from the durable worker records: any that reported and hasn't been
    // acknowledged is still pending, even across a restart. Plus any orphan reports
    // (workers whose record was already gone). Draining marks the records acked.
    const pending = workerList().filter((w) => w.report && !w.ackedAt)
    const reports = [...pending.map((w) => w.report), ...bus.inbox]
    if (!peek) {
      const now = Date.now()
      for (const w of pending) w.ackedAt = now
      if (pending.length) saveWorkers()
      bus.inbox = []
    }
    return { content: [{ type: 'text', text: JSON.stringify(reports) }], structuredContent: { reports } }
  })

  return srv
}

const mcpTransports = new Map()
async function handleMcp(req, res) {
  const sid = req.headers['mcp-session-id']
  if (sid && mcpTransports.has(sid)) return mcpTransports.get(sid).handleRequest(req, res)
  if (req.method === 'POST') {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => mcpTransports.set(id, transport)
    })
    transport.onclose = () => { if (transport.sessionId) mcpTransports.delete(transport.sessionId) }
    const q = new URL(req.url, 'http://localhost').searchParams
    try { await buildMcpServer(q.get('role'), q.get('sid')).connect(transport) } catch (err) { res.writeHead(500); return res.end(String(err?.message || err)) }
    return transport.handleRequest(req, res)
  }
  res.writeHead(400, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid MCP session' }, id: null }))
}

setInterval(() => {
  const now = Date.now()
  for (const [sid, s] of sessions) {
    // The orchestrator and dispatched workers are autonomous — they keep running
    // (and reporting) when the browser is closed, so the detach reaper skips them.
    // A detached user tab lives cfg('detachMinutes'); 0 = never reaped.
    const ttl = cfg('detachMinutes') * 60 * 1000
    if (sid === 'orch:main' || sid.startsWith('work:') || !ttl) continue
    if (!s.clients.size && s.detachedAt && now - s.detachedAt > ttl) { try { s.term.kill() } catch {}; sessions.delete(sid) }
  }
}, 60 * 1000).unref()

// Two WebSocket endpoints share the http server: /pty (terminals) and /events
// (the browser push channel for surface + spaces + context).
const ptyWss = new WebSocketServer({ noServer: true })
const eventsWss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost')
  if (pathname === '/pty') ptyWss.handleUpgrade(req, socket, head, (ws) => ptyWss.emit('connection', ws, req))
  else if (pathname === '/events') eventsWss.handleUpgrade(req, socket, head, (ws) => eventsWss.emit('connection', ws, req))
  else socket.destroy()
})

// Heartbeat every /pty socket. A socket that died silently (laptop sleep, a dropped
// proxy hop) answers no ping and is terminated. The 'hb' frame lets the browser
// spot the same thing from its side and reconnect instead of freezing on its last frame.
const PTY_HB_MS = 15000
setInterval(() => {
  for (const ws of ptyWss.clients) {
    if (ws.alive === false) { ws.terminate(); continue }
    ws.alive = false
    try { ws.ping(); ws.send('{"t":"hb"}') } catch {}
  }
}, PTY_HB_MS).unref()

ptyWss.on('connection', (ws, req) => {
  ws.on('pong', () => { ws.alive = true })
  const url = new URL(req.url, 'http://localhost')
  const sid = url.searchParams.get('sid') || 'eph-' + Math.random().toString(36).slice(2)
  const cwd = url.searchParams.get('cwd') || NEUTRAL
  const kind = url.searchParams.get('cmd') || 'shell'
  if (!authed(req, url)) {
    try { ws.send(JSON.stringify({ t: 'o', d: '\r\n[cockpit: unauthorized — reopen via the token URL]\r\n' })) } catch {}
    return ws.close()
  }
  if (!allowedCwd(cwd)) {
    try { ws.send(JSON.stringify({ t: 'o', d: '\r\n[cockpit: cwd not allowed]\r\n' })) } catch {}
    return ws.close()
  }
  const scheme = url.searchParams.get('scheme')
  if (scheme === 'light' || scheme === 'dark') uiScheme = scheme
  attach(ws, sid, cwd, kind)
})

eventsWss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost')
  if (!authed(req, url)) return ws.close()
  eventClients.add(ws)
  // Prime the new client with the current picture.
  try { ws.send(JSON.stringify({ t: 'surface', payload: bus.surface })) } catch {}
  try { ws.send(JSON.stringify({ t: 'spaces', spaces: workerList() })) } catch {}
  try { ws.send(JSON.stringify({ t: 'context', ctx: readOrchContext() })) } catch {}
  try { ws.send(JSON.stringify({ t: 'sessions', statuses: Object.fromEntries(sessionStatus) })) } catch {}
  ws.on('close', () => eventClients.delete(ws))
})

// Poll the orchestrator's context and push it when it moves.
setInterval(() => {
  const prev = lastContext.pct
  const ctx = readOrchContext()
  if (ctx.pct !== prev) pushContext()
}, 5000).unref()

// Restore the worker/tab registry and layout a previous run persisted, so dispatched spaces
// reappear (and resume on attach) after a server restart. Drop workers whose
// worktree is gone, and re-allow the surviving worktree paths.
function loadPersisted() {
  try {
    for (const w of JSON.parse(readFileSync(WORKERS_FILE, 'utf8'))) {
      if (!w?.workId || !w?.cwd || !existsSync(w.cwd)) continue
      bus.workers.set(w.workId, w)
      dynRoots.add(normalize(w.cwd))
    }
  } catch {}
  // Prune tab records whose worktree is gone (mirrors the worker prune above),
  // so closed-space/deleted-worktree tabs don't accumulate forever.
  try {
    let pruned = false
    for (const [k, v] of JSON.parse(readFileSync(TABS_FILE, 'utf8'))) {
      if (v?.cwd && !existsSync(v.cwd)) { pruned = true; continue }
      tabSessions.set(k, v)
    }
    if (pruned) saveTabs()
  } catch {}
  try { layout = JSON.parse(readFileSync(LAYOUT_FILE, 'utf8')) } catch {}
}
loadPersisted()

server.listen(PORT, HOST, () => {
  // Windows PowerShell 5.1's console isn't UTF-8: → and · come out as mojibake.
  const [arrow, dot] = WIN ? ['->', '-'] : ['→', '·']
  console.log(`Jeeves Cockpit backend ${arrow} http://${HOST}:${PORT} (loopback only)`)
  console.log(`  open (prod):  ${cockpitUrl()}`)
  console.log(`  open (dev):   http://localhost:5173/?token=${TOKEN}`)
  console.log(`repos: ${REPOS.map((r) => r.id).join(', ') || '(none — configure a Jeeves project)'}`)
  console.log(`mcp:  http://${HOST}:${PORT}/mcp  ${dot}  orchestrator session ${ORCH_SESSION_ID}`)
  refreshWorktreeRoots() // learn existing worktree paths so restored spaces are allowed after a reload
})
