// server.mjs over HTTP. It starts listening on import and keeps its state files
// (token, orch-session, layout.json …) in <data-home>/.cockpit, so the test runs a copy
// in a temp dir, with HOME and JEEVES_HOME pointing inside it, and never touches a real
// cockpit.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TOKEN = 'test-token'
const tmp = mkdtempSync(join(tmpdir(), 'jeeves-server-'))
const COCKPIT = join(tmp, 'cockpit')
const HOME = join(tmp, 'home')
const DATA = join(HOME, 'jeeves')
const STATE = join(DATA, '.cockpit')
// State an earlier version left beside server.mjs, adopted on the first boot.
const LEGACY_ORCH_SESSION = '0f0f0f0f-1111-4222-8333-444444444444'
// Stand-ins first on PATH: `claude` records its argv and the env vars in CLAUDE_ENV, then
// exits (or, when its last argument contains [stay] or STAY exists, keeps running); `gh` logs its argv to
// GH_LOG, answers every GraphQL search with no PRs, `api user` as "me", and `pr view <n>`
// with a PR that is the user's own when n is 1 or 3 (#3 titled "ABC-123 fix").
const BIN = join(tmp, 'bin')
const CLAUDE_ARGS = join(tmp, 'claude-args.json')
const CLAUDE_ENV = join(tmp, 'claude-env.json')
const GH_LOG = join(tmp, 'gh-args.jsonl')
const STAY = join(tmp, 'claude-stay'), TYPED = join(tmp, 'claude-typed.txt') // while STAY exists, claude keeps running and logs what is typed to it
const FAKE_GH = `const a = process.argv.slice(2)
require('fs').appendFileSync(${JSON.stringify(GH_LOG)}, JSON.stringify(a) + '\\n')
const q = (a.find((x) => x.startsWith('query=')) || '').slice(6), data = {}
if (a[0] === 'api' && a[1] === 'user') process.stdout.write('me\\n')
else if (a[0] === 'pr' && a[1] === 'view') process.stdout.write(JSON.stringify({ number: +a[2], author: { login: ['1', '3'].includes(a[2]) ? 'me' : 'someone' }, isDraft: false, title: a[2] === '3' ? 'ABC-123 fix' : 'fix it' }))
else if (a[0] === 'pr' && a[1] === 'edit') {}
else {
  for (const m of q.matchAll(/(\\w+):search\\(/g)) data[m[1]] = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }
  if (/viewer/.test(q)) data.viewer = { login: 'me' }
  process.stdout.write(JSON.stringify({ data }))
}`
const ghCalls = () => (existsSync(GH_LOG) ? readFileSync(GH_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])
const POSIX = process.platform !== 'win32' || 'the stand-in claude and gh are shebang scripts'
let srv, base, port

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer().once('error', rej)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)) })
})

before(async () => {
  mkdirSync(COCKPIT, { recursive: true })
  mkdirSync(DATA, { recursive: true })
  copyFileSync(join(ROOT, 'server.mjs'), join(COCKPIT, 'server.mjs'))
  cpSync(join(ROOT, '..', 'agents'), join(tmp, 'agents'), { recursive: true }) // the built-ins, beside cockpit/ as in the plugin
  cpSync(join(ROOT, 'bin'), join(COCKPIT, 'bin'), { recursive: true })
  cpSync(join(ROOT, 'lib'), join(COCKPIT, 'lib'), { recursive: true })
  symlinkSync(join(ROOT, 'node_modules'), join(COCKPIT, 'node_modules'), 'junction')
  writeFileSync(join(COCKPIT, '.jeeves-orch-session'), LEGACY_ORCH_SESSION)
  mkdirSync(join(COCKPIT, '.jeeves-sessions')); writeFileSync(join(COCKPIT, '.jeeves-sessions', 'old.mcp.json'), '{}')
  mkdirSync(BIN)
  writeFileSync(join(BIN, 'claude'), `#!${process.execPath}\nconst fs = require('fs'), e = process.env
fs.writeFileSync(${JSON.stringify(CLAUDE_ENV)}, JSON.stringify({ JEEVES_TOKEN: e.JEEVES_TOKEN ?? null, JEEVES_USAGE_URL: e.JEEVES_USAGE_URL ?? null, JEEVES_HOOK_URL: e.JEEVES_HOOK_URL ?? null, MAX_MCP_OUTPUT_TOKENS: e.MAX_MCP_OUTPUT_TOKENS, git: Object.fromEntries(Object.entries(e).filter(([k]) => k.startsWith('GIT_CONFIG_'))) }))
fs.writeFileSync(${JSON.stringify(CLAUDE_ARGS)}, JSON.stringify(process.argv.slice(2)))
if (String(process.argv.at(-1)).includes('[stay]') || fs.existsSync(${JSON.stringify(STAY)})) { process.stdin.on('data', (d) => fs.appendFileSync(${JSON.stringify(TYPED)}, d)); setInterval(() => {}, 1000) }\n`)
  writeFileSync(join(BIN, 'gh'), `#!${process.execPath}\n${FAKE_GH}\n`)
  chmodSync(join(BIN, 'claude'), 0o755); chmodSync(join(BIN, 'gh'), 0o755)
  do port = await freePort(); while (port === 4177)
  await start()
})
after(() => { srv?.kill(); rmSync(tmp, { recursive: true, force: true }) })

// Start (or, after stop, restart) the server on `port`, with its state files where the last run left them
// and any extra environment.
async function start(extraEnv = {}) {
  srv = spawn(process.execPath, [join(COCKPIT, 'server.mjs')], {
    cwd: COCKPIT,
    env: { ...process.env, PATH: `${BIN}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`, HOME, USERPROFILE: HOME, PORT: String(port), JEEVES_TOKEN: TOKEN, JEEVES_HOME: DATA, JEEVES_SCRATCH_ROOT: '', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('server did not start:\n' + log)), 10000)
    const on = (d) => { log += d; if (/Jeeves Cockpit backend/.test(log)) { clearTimeout(t); res() } }
    srv.stdout.on('data', on); srv.stderr.on('data', on)
    srv.once('exit', (code) => { clearTimeout(t); rej(new Error(`server exited ${code}:\n${log}`)) })
  })
  srv.log = () => log
  base = `http://127.0.0.1:${port}`
}
const stop = () => new Promise((res) => { srv.once('exit', res); srv.kill() })

async function api(path, body, { token = TOKEN, raw } = {}) {
  const r = await fetch(base + path, {
    method: body === undefined && raw === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body))
  })
  return { status: r.status, body: await r.json() }
}
const alive = async () => assert.equal((await api('/api/layout')).status, 200)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(what, ok, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) { const v = await ok(); if (v) return v }
  assert.fail('timed out waiting for ' + what)
}

// An MCP session, as the orchestrator by default (the browser token gets the full tool set)
// or as whoever `token` was minted for. call → the tool's text, failing on a tool error;
// raw → the whole result.
async function mcpClient(token = TOKEN, path = '/mcp') {
  const { Client } = await import(join(ROOT, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'))
  const { StreamableHTTPClientTransport } = await import(join(ROOT, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js'))
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(base + path), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  const raw = (name, args = {}) => client.callTool({ name, arguments: args })
  const call = async (name, args) => { const r = await raw(name, args); assert.ok(!r.isError, JSON.stringify(r.content)); return r.content[0].text }
  return { client, raw, call }
}
// A socket to /events (a connected browser) that keeps every message, or to /pty.
function socket(path) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}${path.includes('?') ? '&' : '?'}token=${TOKEN}`)
  ws.msgs = []
  ws.on('message', (d) => { try { ws.msgs.push(JSON.parse(d)) } catch {} })
  return new Promise((res, rej) => { ws.once('open', () => res(ws)); ws.once('error', rej) })
}
const pty = (sid, cmd, cwd = HOME) => socket(`/pty?sid=${encodeURIComponent(sid)}&cmd=${cmd}&cwd=${encodeURIComponent(cwd)}`)
// A lifecycle hook's POST, on the hook URL a launched session carries in its environment
// (a claude tab is started to learn it when none has run yet).
async function hook(body) {
  if (!existsSync(CLAUDE_ENV)) { const ws = await pty('scratch:hookenv', 'claude'); await until('a claude to run', () => existsSync(CLAUDE_ENV)); ws.close() }
  const r = await fetch(JSON.parse(readFileSync(CLAUDE_ENV, 'utf8')).JEEVES_HOOK_URL, { method: 'POST', body: JSON.stringify(body) })
  assert.equal(r.status, 200)
}
const freshArgs = () => { try { unlinkSync(CLAUDE_ARGS) } catch {} }
const claudeArgs = () => until('the stand-in claude to run', () => existsSync(CLAUDE_ARGS) && JSON.parse(readFileSync(CLAUDE_ARGS, 'utf8')))

test('auth', async () => {
  assert.equal((await api('/api/layout', undefined, { token: 'wrong' })).status, 401)
})

test('/api/reminders', async (t) => {
  const FILE = join(DATA, 'reminders.md')
  const HEADER = '# reminders\n<!-- keep -->\n'
  await t.test('empty without a file', async () => {
    assert.deepEqual((await api('/api/reminders')).body, { reminders: [] })
  })
  await t.test('add appends a row', async () => {
    const r = await api('/api/reminders', { op: 'add', what: 'ping Bob', due: '2026-10-01 09:00' })
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.reminders.map(({ id, due, what }) => ({ id, due, what })), [{ id: 'r1', due: '2026-10-01 09:00', what: 'ping Bob' }])
    assert.match(readFileSync(FILE, 'utf8'), /^# reminders\n[^]*\n- r1 · due 2026-10-01 09:00 · ping Bob · set \d{4}-\d{2}-\d{2}\n$/)
  })
  await t.test('add accepts the datetime-input T form', async () => {
    const r = await api('/api/reminders', { op: 'add', what: 'second', due: '2026-10-02T10:30' })
    assert.equal(r.body.reminders.find((x) => x.id === 'r2')?.due, '2026-10-02 10:30')
  })
  await t.test('add rejects an impossible date without crashing', async () => {
    const r = await api('/api/reminders', { op: 'add', what: 'nope', due: '2026-02-30 10:00' })
    assert.equal(r.status, 400)
    assert.match(r.body.error, /YYYY-MM-DD HH:MM/)
    await alive()
  })
  await t.test('add rejects empty and multi-line text', async () => {
    assert.equal((await api('/api/reminders', { op: 'add', what: ' ', due: '2026-10-01 09:00' })).status, 400)
    assert.equal((await api('/api/reminders', { op: 'add', what: 'a\nb', due: '2026-10-01 09:00' })).status, 400)
  })
  await t.test('snooze of an impossible stored date moves it an hour past now', async () => {
    writeFileSync(FILE, HEADER + '- r7 · due 2026-02-30 10:00 · odd · set 2026-01-01\nnot a row\n')
    const before = Date.now()
    const r = await api('/api/reminders', { op: 'snooze', id: 'r7', by: '1h' })
    assert.equal(r.status, 200)
    const [, y, mo, d, h, mi] = r.body.reminders[0].due.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/).map(Number)
    const at = new Date(y, mo - 1, d, h, mi).getTime()
    assert.ok(at >= before + 3600e3 - 60e3 && at <= Date.now() + 3600e3, 'about an hour from now')
    assert.match(readFileSync(FILE, 'utf8'), /^# reminders\n<!-- keep -->\n- r7 · due .* · odd · set 2026-01-01\nnot a row\n$/)
    await alive()
  })
  await t.test('snooze of a future date moves it a day from its due time', async () => {
    writeFileSync(FILE, HEADER + '- r1 · due 2099-01-31 23:30 · later\n')
    const r = await api('/api/reminders', { op: 'snooze', id: 'r1', by: '1d' })
    assert.equal(r.body.reminders[0].due, '2099-02-01 23:30')
  })
  await t.test('bad snooze, unknown id and unknown op are 400s', async () => {
    assert.equal((await api('/api/reminders', { op: 'snooze', id: 'r1', by: '2w' })).status, 400)
    assert.equal((await api('/api/reminders', { op: 'done', id: 'r99' })).status, 400)
    assert.equal((await api('/api/reminders', { op: 'frobnicate', id: 'r1' })).status, 400)
  })
  await t.test('done without an id touches nothing', async () => {
    writeFileSync(FILE, HEADER + '- r1 · due 2099-01-31 23:30 · later\n')
    assert.equal((await api('/api/reminders', { op: 'done' })).status, 400)
    assert.equal((await api('/api/reminders', undefined, { raw: 'not json' })).status, 400)
    assert.equal(readFileSync(FILE, 'utf8'), HEADER + '- r1 · due 2099-01-31 23:30 · later\n')
  })
  await t.test('done removes only its row', async () => {
    writeFileSync(FILE, HEADER + '- r1 · due 2099-01-31 23:30 · a\n- r2 · due 2099-01-31 23:30 · b\n')
    const r = await api('/api/reminders', { op: 'done', id: 'r1' })
    assert.deepEqual(r.body.reminders.map((x) => x.id), ['r2'])
    assert.equal(readFileSync(FILE, 'utf8'), HEADER + '- r2 · due 2099-01-31 23:30 · b\n')
  })
})

test('/api/agents', async (t) => {
  const agent = { description: 'My take.', tools: ['Read'], model: 'inherit', prompt: 'Review it my way.' }
  await t.test('lists every built-in', async () => {
    const names = (await api('/api/agents')).body.builtin.map((a) => a.name)
    assert.deepEqual(names, ['investigator', 'loop-verifier', 'planner', 'review-resolver', 'reviewer', 'story-worker'])
  })
  await t.test('the worker label is reserved', async () => {
    assert.equal((await api('/api/agents', { op: 'save', agent: { ...agent, name: 'worker' }, isNew: true })).status, 400)
  })
  await t.test('saving a built-in\'s name customises it', async () => {
    const r = await api('/api/agents', { op: 'save', agent: { ...agent, name: 'reviewer' } })
    assert.equal(r.status, 200)
    const b = r.body.builtin.find((a) => a.name === 'reviewer')
    assert.equal(b.override.prompt, 'Review it my way.\n')
    assert.equal(b.override.stale, false)
    assert.equal((await api('/api/agents', { op: 'delete', name: 'reviewer' })).body.builtin.find((a) => a.name === 'reviewer').override, null)
  })
})

// The demo project: a checkout at ~/Dev/demo whose origin is a bare repo beside it.
const REPO = join(HOME, 'Dev', 'demo'), ORIGIN = join(tmp, 'origin.git')
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

test('a reviewer dispatch carries the project\'s review command', { skip: POSIX !== true && POSIX }, async () => {
  mkdirSync(REPO, { recursive: true })
  git(REPO, 'init', '-q', '-b', 'main'); git(REPO, 'commit', '-q', '--allow-empty', '-m', 'init')
  execFileSync('git', ['init', '-q', '--bare', ORIGIN]); git(REPO, 'remote', 'add', 'origin', ORIGIN); git(REPO, 'push', '-q', 'origin', 'main')
  const { client, call } = await mcpClient()
  try {
    await call('create_project', { id: 'demo', repo: 'acme/demo', path: REPO, baseBranch: 'main', reviewCommand: '/code-review high' })
    const out = JSON.parse(await call('dispatch', { agent: 'reviewer', repo: 'demo', ticket: '7', prompt: 'Review PR #7 against main.' }))
    assert.ok(out.workId, JSON.stringify(out))
    for (let i = 0; i < 50 && !existsSync(CLAUDE_ARGS); i++) await new Promise((r) => setTimeout(r, 100))
    const argv = JSON.parse(readFileSync(CLAUDE_ARGS, 'utf8'))
    assert.deepEqual(argv.slice(-2), ['--', 'Review PR #7 against main.\n\nReview command for this project: /code-review high'])
    assert.equal(argv[argv.indexOf('--agent') + 1], 'reviewer')
  } finally { await client.close() }
})

test('/api/layout', async (t) => {
  await t.test('starts empty', async () => assert.deepEqual((await api('/api/layout')).body, { layout: null }))
  await t.test('saves and returns a layout', async () => {
    const layout = { spaces: [{ id: 's1', tabs: [] }], pinned: ['api'] }
    assert.deepEqual((await api('/api/layout', { layout, from: 'b1' })).body, { ok: true })
    assert.deepEqual((await api('/api/layout')).body, { layout })
    assert.deepEqual(JSON.parse(readFileSync(join(STATE, 'layout.json'), 'utf8')), layout)
  })
  await t.test('rejects bad input and keeps the saved layout', async () => {
    for (const body of [{}, { layout: 'x' }, { layout: {} }, { layout: { spaces: 'no' } }]) {
      assert.equal((await api('/api/layout', body)).status, 400, JSON.stringify(body))
    }
    assert.equal((await api('/api/layout', undefined, { raw: '{broken' })).status, 400)
    assert.deepEqual((await api('/api/layout')).body.layout.pinned, ['api'])
  })
})

test('/api/folder', async (t) => {
  mkdirSync(join(HOME, 'proj', 'b'), { recursive: true })
  mkdirSync(join(HOME, 'proj', 'A'))
  mkdirSync(join(HOME, 'proj', '.hidden'))
  writeFileSync(join(HOME, 'proj', 'file.txt'), 'x')
  const folder = (p, list) => api('/api/folder?path=' + encodeURIComponent(p) + (list ? '&list=1' : ''))

  await t.test('a folder', async () => {
    assert.deepEqual(await folder(join(HOME, 'proj')), { status: 200, body: { path: join(HOME, 'proj'), name: 'proj' } })
  })
  await t.test('~ is the home dir', async () => {
    assert.deepEqual((await folder('~')).body, { path: HOME, name: 'home' })
    assert.equal((await folder('~/proj')).body.path, join(HOME, 'proj'))
  })
  await t.test('blank is the scratch root', async () => assert.equal((await folder('')).body.path, HOME))
  await t.test('a file is refused', async () => {
    const r = await folder(join(HOME, 'proj', 'file.txt'))
    assert.equal(r.status, 400)
    assert.match(r.body.error, /not a folder/)
  })
  await t.test('a missing path is refused', async () => assert.equal((await folder(join(HOME, 'nope'))).status, 400))
  await t.test('outside home is refused', async () => {
    const r = await folder(dirname(HOME))
    assert.equal(r.status, 400)
    assert.match(r.body.error, /outside/)
    assert.equal((await folder(join(HOME, '..', '..'))).status, 400)
  })
  await t.test('list=1 gives sorted subfolders, no dot-folders, and the parent', async () => {
    const r = await folder(join(HOME, 'proj'), true)
    assert.deepEqual(r.body, { path: join(HOME, 'proj'), name: 'proj', parent: HOME, dirs: ['A', 'b'] })
  })
  await t.test('list=1 at the root has no parent', async () => {
    assert.equal((await folder(HOME, true)).body.parent, null)
  })
  await t.test('list=1 on a refused path is still an error', async () => {
    assert.equal((await folder(dirname(HOME), true)).status, 400)
  })
  await t.test('a relative path is under the scratch root, not the server\'s cwd', async () => {
    assert.equal((await folder('proj')).body.path, join(HOME, 'proj'))
  })
  await t.test('~user is refused', async () => {
    const r = await folder('~nobody/x')
    assert.equal(r.status, 400)
    assert.match(r.body.error, /not supported/)
  })
  await t.test('a symlink out of the root is refused', async () => {
    symlinkSync(tmp, join(HOME, 'out'), 'junction')
    const r = await folder(join(HOME, 'out'))
    assert.equal(r.status, 400)
    assert.match(r.body.error, /outside/)
  })
})

test('a null or non-object JSON body never crashes the server', async () => {
  for (const raw of ['null', '[]', '42', '"x"']) {
    for (const path of ['/api/settings', '/api/agents', '/api/reminders', '/api/hook', '/api/revert', '/api/open', '/api/settings/config', '/api/orch/input', '/api/tab-prompt', '/api/layout', '/api/worktree']) {
      assert.ok((await api(path, undefined, { raw })).status < 500, `${path} ${raw}`)
    }
  }
  await alive()
})

test('PTYs never see the browser token; /api/usage takes any body', { skip: POSIX !== true && POSIX }, async () => {
  const env = JSON.parse(readFileSync(CLAUDE_ENV, 'utf8')) // from the reviewer dispatch
  assert.equal(env.JEEVES_TOKEN, null)
  const usage = (body) => fetch(env.JEEVES_USAGE_URL, { method: 'POST', body })
  for (const body of ['null', '[]', 'nope']) assert.equal((await usage(body)).status, 200)
  await alive()
  await usage(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12, resets_at: 1 } } }))
  const ctx = (await api('/api/orch/context')).body
  assert.equal(ctx.usage.fiveHour.used, 12)
  assert.ok(ctx.startedAt > 0 && ctx.startedAt <= Date.now() && ctx.lastTickAt === 0, 'startedAt set, never ticked')
})

test('/api/statusline', async (t) => {
  const dir = join(HOME, '.claude'), file = join(dir, 'settings.json')
  const baks = () => readdirSync(dir).filter((n) => n.startsWith('settings.json.bak-jeeves-'))
  mkdirSync(dir, { recursive: true })
  await t.test('a settings.json that is null is an error, not a crash', async () => {
    writeFileSync(file, 'null')
    assert.equal((await api('/api/statusline')).status, 500)
    assert.equal((await api('/api/statusline', undefined, { raw: 'null' })).status, 500)
    await alive()
  })
  await t.test('another status line needs confirming, and is left alone', async () => {
    const mine = JSON.stringify({ statusLine: { type: 'command', command: 'echo mine' } })
    writeFileSync(file, mine)
    assert.deepEqual((await api('/api/statusline', {})).body, { current: 'echo mine', installed: false, needsConfirm: true })
    assert.equal(readFileSync(file, 'utf8'), mine)
  })
  await t.test('installs through a symlinked settings.json, runs on this node, keeps 3 backups', async () => {
    const real = join(HOME, 'dotfiles', 'settings.json')
    mkdirSync(dirname(real), { recursive: true })
    writeFileSync(real, JSON.stringify({ theme: 'dark', statusLine: { command: 'echo mine' } }))
    rmSync(file); symlinkSync(real, file)
    for (let i = 0; i < 5; i++) {
      const r = await api('/api/statusline', { replace: true })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      await sleep(5) // a distinct backup name each time
    }
    assert.ok(lstatSync(file).isSymbolicLink(), 'still a symlink')
    const cfg = JSON.parse(readFileSync(real, 'utf8'))
    assert.equal(cfg.theme, 'dark')
    assert.equal(cfg.statusLine.command, `"${process.execPath}" "${join(dir, 'jeeves-statusline.mjs')}"`)
    assert.ok(existsSync(join(dir, 'jeeves-statusline.mjs')))
    assert.equal(baks().length, 3)
    assert.deepEqual(readdirSync(dirname(real)), ['settings.json'], 'no temp file left beside it')
    assert.deepEqual((await api('/api/statusline')).body, { current: cfg.statusLine.command, installed: true })
  })
})

test('a stale SessionEnd from a replaced orchestrator is ignored', { skip: POSIX !== true && POSIX }, async () => {
  const before = (await api('/api/orch/context')).body
  await hook({ id: 'orch:main', status: 'offline', sessionId: '00000000-0000-4000-8000-000000000000' })
  const now = (await api('/api/orch/context')).body
  assert.equal(now.sessionId, before.sessionId)
  assert.notEqual(now.status, 'exited')
})

test('dispatch reuses a finished worktree, brought up to date, and never the main checkout', { skip: POSIX !== true && POSIX }, async () => {
  const { client, call, raw } = await mcpClient()
  try {
    const onMain = await raw('dispatch', { agent: 'story-worker', repo: 'demo', branch: 'main', prompt: 'x' })
    assert.ok(onMain.isError, JSON.stringify(onMain.content))
    freshArgs()
    const first = JSON.parse(await call('dispatch', { agent: 'story-worker', repo: 'demo', branch: 'feat-x', prompt: 'x' }))
    assert.equal(first.reused, undefined)
    await claudeArgs()
    await until('the first worker to exit', async () => (await api('/api/spaces')).body.spaces.find((w) => w.workId === first.workId)?.status === 'exited')
    git(first.cwd, 'push', '-q', '-u', 'origin', 'feat-x')
    const other = join(tmp, 'other')
    execFileSync('git', ['clone', '-q', '-b', 'feat-x', ORIGIN, other], { stdio: 'ignore' })
    git(other, 'commit', '-q', '--allow-empty', '-m', 'more'); git(other, 'push', '-q')
    const second = JSON.parse(await call('dispatch', { agent: 'story-worker', repo: 'demo', branch: 'feat-x', prompt: 'y' }))
    assert.equal(realpathSync(second.cwd), realpathSync(first.cwd))
    assert.deepEqual([second.reused, second.ahead, second.behind, second.fastForwarded], [true, 0, 0, 1])
    assert.equal(git(first.cwd, 'rev-parse', 'HEAD'), git(other, 'rev-parse', 'HEAD'))
    const there = (await api('/api/spaces')).body.spaces.filter((w) => realpathSync(w.cwd) === realpathSync(first.cwd)).map((w) => w.workId)
    assert.deepEqual(there, [second.workId], 'the finished record is retired')
  } finally { await client.close() }
})

test('dispatch onto a teammate\'s branch never fetched here checks out its pushed head', { skip: POSIX !== true && POSIX }, async () => {
  const mate = join(tmp, 'mate')
  execFileSync('git', ['clone', '-q', ORIGIN, mate], { stdio: 'ignore' })
  git(mate, 'checkout', '-q', '-b', 'mate-pr'); git(mate, 'commit', '-q', '--allow-empty', '-m', 'their work'); git(mate, 'push', '-q', 'origin', 'mate-pr')
  const { client, call } = await mcpClient()
  try {
    freshArgs()
    const out = JSON.parse(await call('dispatch', { agent: 'reviewer', repo: 'demo', branch: 'mate-pr', prompt: 'Review PR #8.' }))
    assert.ok(out.workId, JSON.stringify(out))
    await claudeArgs()
    assert.equal(git(out.cwd, 'rev-parse', 'HEAD'), git(mate, 'rev-parse', 'HEAD'))
    assert.equal(git(out.cwd, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/mate-pr')
  } finally { await client.close() }
})

test('dispatch moves a folder in the way aside, never deleting it', { skip: POSIX !== true && POSIX }, async () => {
  const wt = join(`${REPO}-worktrees`, 'feat-left')
  mkdirSync(wt, { recursive: true }); writeFileSync(join(wt, 'keep.txt'), 'mine')
  const { client, call } = await mcpClient()
  try {
    freshArgs()
    const out = JSON.parse(await call('dispatch', { agent: 'story-worker', repo: 'demo', branch: 'feat-left', prompt: 'x' }))
    assert.ok(out.workId, JSON.stringify(out))
    await claudeArgs()
    assert.match(out.movedAside, /feat-left\.stale-\d{14}$/)
    assert.equal(readFileSync(join(out.movedAside, 'keep.txt'), 'utf8'), 'mine')
    assert.equal(git(out.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat-left')
  } finally { await client.close() }
})

test('dispatch prunes a registered worktree whose folder is gone, then checks it out', { skip: POSIX !== true && POSIX }, async () => {
  const wt = join(`${REPO}-worktrees`, 'feat-gone-wt')
  git(REPO, 'worktree', 'add', '-q', '-b', 'feat-gone-wt', wt)
  rmSync(wt, { recursive: true, force: true })
  const { client, call } = await mcpClient()
  try {
    freshArgs()
    const out = JSON.parse(await call('dispatch', { agent: 'story-worker', repo: 'demo', branch: 'feat-gone-wt', prompt: 'x' }))
    assert.ok(out.workId, JSON.stringify(out))
    await claudeArgs()
    assert.equal(out.movedAside, undefined)
    assert.equal(git(out.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat-gone-wt')
    // Registered at the path under no branch (detached): git refuses the add, prune clears it.
    const det = join(`${REPO}-worktrees`, 'feat-detached')
    git(REPO, 'worktree', 'add', '-q', '--detach', det)
    rmSync(det, { recursive: true, force: true })
    freshArgs()
    const again = JSON.parse(await call('dispatch', { agent: 'story-worker', repo: 'demo', branch: 'feat-detached', prompt: 'x' }))
    assert.ok(again.workId, JSON.stringify(again))
    await claudeArgs()
    assert.equal(git(again.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat-detached')
  } finally { await client.close() }
})

test('tick_snapshot is whole again after a compaction',{ skip: POSIX !== true && POSIX }, async () => {
  const { client, call } = await mcpClient()
  try {
    const tick = async () => Object.keys(JSON.parse(await call('tick_snapshot', {})))
    assert.ok((await tick()).includes('projects'))
    assert.ok((await tick()).includes('delta'))
    await hook({ id: 'orch:main', status: 'compact' }) // the PreCompact hook
    assert.ok((await tick()).includes('projects'))
    assert.ok((await tick()).includes('delta'))
  } finally { await client.close() }
})

test('surface_render takes only http(s) action links', async () => {
  const { client, raw } = await mcpClient()
  try {
    const paint = (href) => raw('surface_render', { stories: [{ item: 'ABC-1 — x', actions: [{ label: 'Open', href }] }] })
    assert.ok(!(await paint('https://example.com/plan')).isError)
    assert.ok((await paint('javascript:alert(1)')).isError)
    assert.ok((await paint('file:///etc/passwd')).isError)
  } finally { await client.close() }
})

test('/api/tab-prompt', { skip: POSIX !== true && POSIX }, async (t) => {
  await t.test('needs the token', async () => assert.equal((await api('/api/tab-prompt', { tabId: 'abcd', prompt: 'x' }, { token: 'wrong' })).status, 401))
  await t.test('refuses a bad tab id or prompt', async () => {
    for (const body of [{ tabId: 'AB!x', prompt: 'x' }, { tabId: 'ab', prompt: 'x' }, { tabId: 'abcd' }, { tabId: 'abcd', prompt: ' ' }, { tabId: 'abcd', prompt: 'x'.repeat(4001) }, { tabId: 'abcd', prompt: 7 }]) {
      assert.equal((await api('/api/tab-prompt', body)).status, 400, JSON.stringify(body))
    }
  })
  await t.test('a claude tab starts on it, on its first spawn only', async () => {
    assert.deepEqual((await api('/api/tab-prompt', { tabId: 'tp1abc', prompt: '/jeeves:setup --scan' })).body, { ok: true })
    freshArgs()
    const ws = await pty('scratch:tp1abc', 'claude')
    assert.equal((await claudeArgs()).at(-1), '/jeeves:setup --scan')
    await until('the tab to exit', () => ws.msgs.some((m) => m.t === 'exit'))
    ws.close()
    freshArgs()
    const again = await pty('scratch:tp1abc', 'claude')
    assert.notEqual((await claudeArgs()).at(-1), '/jeeves:setup --scan')
    again.close()
  })
  await t.test('a prompt starting with - follows --, so it is never read as a flag', async () => {
    assert.equal((await api('/api/tab-prompt', { tabId: 'tp2abc', prompt: '- fix login' })).status, 200)
    freshArgs()
    const ws = await pty('scratch:tp2abc', 'claude')
    assert.deepEqual((await claudeArgs()).slice(-2), ['--', '- fix login'])
    ws.close()
  })
})

test('orchestrator tabs: add_tab, inbox, close_tab, and a restart', { skip: POSIX !== true && POSIX }, async () => {
  let events = await socket('/events'), mcp = await mcpClient()
  const tabs = async () => JSON.parse(await mcp.call('inbox', { peek: true })).tabs
  try {
    freshArgs()
    const added = await mcp.raw('add_tab', { space: 'scratch', prompt: 'hello there' })
    assert.ok(!added.isError, JSON.stringify(added.content))
    const ref = added.structuredContent.tabRef
    const msg = await until('the add_tab broadcast', () => events.msgs.find((m) => m.t === 'add_tab' && m.tab?.id === ref))
    assert.deepEqual(msg, { t: 'add_tab', spaceId: 'scratch', kind: 'claude', tab: { id: ref, kind: 'claude' } })
    const ws = await pty(`scratch:${ref}`, 'claude')
    assert.equal((await claudeArgs()).at(-1), 'hello there')
    ws.close()

    freshArgs()
    const opened = await mcp.raw('open_space', { repo: 'demo', prompt: 'why does X?' })
    assert.ok(!opened.isError, JSON.stringify(opened.content))
    const { spaceRef, tabRef, cwd } = opened.structuredContent
    const asked = await pty(`${spaceRef}:${tabRef}`, 'claude', cwd)
    assert.equal((await claudeArgs()).at(-1), 'why does X?', 'the first claude tab starts on the prompt')
    asked.close()
    assert.equal((await tabs()).find((x) => x.tabRef === tabRef)?.prompt, 'why does X?', 'inbox lists the prompt it opened on')
    assert.ok((await mcp.raw('open_space', { repo: 'demo', command: 'ls', prompt: 'x' })).isError, 'a prompt is for a claude tab')
    assert.ok((await mcp.raw('open_space', { repo: 'demo', prompt: ' ' })).isError, 'an empty prompt')

    assert.ok((await mcp.raw('add_tab', { space: 'scratch', spaceRef: 'os1' })).isError, 'one of space or spaceRef')
    assert.ok((await mcp.raw('add_tab', { space: 'scratch', tab: 'shell', prompt: 'x' })).isError, 'a prompt is for claude tabs')
    assert.ok((await mcp.raw('close_tab', { tabRef: 'tp1abc' })).isError, 'only tabs the orchestrator opened')

    await mcp.call('add_tab', { space: 'scratch', command: 'yarn --version' })
    const log = readFileSync(join(DATA, 'guard.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1)
    assert.deepEqual([log.tool, log.what, log.why, log.allowed], ['mcp__cockpit__add_tab', 'yarn --version', 'ran for the user', true])

    const sh = (await mcp.raw('add_tab', { space: 'scratch', tab: 'shell' })).structuredContent.tabRef
    const shell = await pty(`scratch:${sh}`, 'shell')
    const listed = (await tabs()).find((x) => x.tabRef === sh)
    assert.deepEqual({ ...listed, openedAt: typeof listed.openedAt }, { tabRef: sh, space: 'scratch', kind: 'shell', openedAt: 'number', status: 'running' })
    await mcp.call('close_tab', { tabRef: sh })
    await until('the shell to end', () => shell.msgs.some((m) => m.t === 'exit'))
    await until('the close_tab broadcast', () => events.msgs.some((m) => m.t === 'close_tab' && m.tabId === sh))
    assert.equal((await tabs()).some((x) => x.tabRef === sh), false)
    shell.close()

    await mcp.client.close(); events.close()
    await stop(); await start()
    events = await socket('/events'); mcp = await mcpClient()
    const kept = (await tabs()).find((x) => x.tabRef === ref)
    assert.deepEqual([kept?.prompt, kept?.status], ['hello there', 'not started'])
  } finally { await mcp.client.close().catch(() => {}); events.close() }
})

test('/pty refuses with a fatal frame, then closes', async (t) => {
  const { WebSocket } = await import(join(ROOT, 'node_modules/ws/wrapper.mjs'))
  const frames = (qs) => new Promise((res, rej) => {
    const got = [], ws = new WebSocket(base.replace('http', 'ws') + '/pty?' + qs)
    ws.on('message', (d) => got.push(JSON.parse(String(d))))
    ws.on('close', () => res(got)); ws.on('error', rej)
  })
  await t.test('unauthorized', async () => {
    const got = await frames('sid=s:t1&cmd=shell&token=wrong')
    assert.deepEqual(got.at(-1), { t: 'fatal', reason: 'unauthorized' })
  })
  await t.test('cwd not allowed', async () => {
    const got = await frames(`sid=s:t2&cmd=shell&cwd=${encodeURIComponent(dirname(HOME))}&token=${TOKEN}`)
    assert.deepEqual(got.at(-1), { t: 'fatal', reason: 'cwd not allowed' })
  })
})

// A background Claude session (Claude Code's daemon, `--fork-session`) inherits the closed
// session's --settings, its per-session settings file; closing the session ends it too.
// Stand-ins carry that path in their argv exactly as a real forked session does.
test('closing a session ends background Claude processes carrying its hook id', { skip: process.platform === 'win32' && 'ps-based' }, async () => {
  const marker = (id) => join(STATE, 'sessions', id.replace(':', '+') + '.settings.json')
  const bg = (id) => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--settings', marker(id)], { stdio: 'ignore', detached: true })
  const gone = (p) => { try { process.kill(p.pid, 0); return false } catch { return true } }
  const doomed = bg('bgt1:tab1'), other = bg('bgt1:tab2')
  try {
    await sleep(200)
    await fetch(`${base}/api/session?sid=${encodeURIComponent('bgt1:tab1')}`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` } })
    await until('the background session to end', () => gone(doomed), 6000)
    assert.equal(gone(other), false, 'a different session\'s background process must survive')
  } finally { for (const p of [doomed, other]) { try { process.kill(p.pid, 'SIGKILL') } catch {} } }
})

// ── Security ──
import http from 'node:http'
// A raw request, so the Host and Origin headers are exactly what the test says.
const rawReq = (path, headers = {}, method = 'GET', body) => new Promise((res, rej) => {
  const r = http.request({ host: '127.0.0.1', port, path, method, headers: { authorization: `Bearer ${TOKEN}`, ...headers } }, (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => res({ status: x.statusCode, body: b })) })
  r.on('error', rej); r.end(body)
})
const sessionsDir = () => join(STATE, 'sessions')
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'))
// The MCP token a launched session was minted, from its --mcp-config file.
const mintedToken = (sid) => readJson(join(sessionsDir(), sid.replace(':', '+') + '.mcp.json')).mcpServers.cockpit.headers.Authorization.slice(7)
const toolNames = async (c) => (await c.client.listTools()).tools.map((t) => t.name).sort()

test('the first boot adopts the state an earlier version left beside server.mjs', () => {
  assert.equal(readFileSync(join(STATE, 'orch-session'), 'utf8'), LEGACY_ORCH_SESSION)
  assert.equal(existsSync(join(COCKPIT, '.jeeves-orch-session')), false, 'moved, not copied')
  assert.equal(existsSync(join(COCKPIT, '.jeeves-sessions')), false, 'stale session files dropped')
})

test('unknown /api paths are a 404 JSON', async () => {
  const r = await api('/api/nope')
  assert.deepEqual([r.status, r.body], [404, { error: 'not found' }])
  assert.equal((await api('/api/nope', undefined, { token: 'wrong' })).status, 401)
})

test('a body over 1 MB is a 413, and the server lives on', async () => {
  const r = await api('/api/layout', undefined, { raw: JSON.stringify({ layout: { spaces: [], pad: 'x'.repeat(1100 * 1024) } }) })
  assert.equal(r.status, 413)
  await alive()
})

test('a tunnel\'s Host and Origin are served; the token is the gate', async (t) => {
  const tunnel = { host: 'abc123.ngrok-free.app', origin: 'https://abc123.ngrok-free.app' }
  await t.test('HTTP under a tunnel hostname: served with the token, 401 without', async () => {
    assert.equal((await rawReq('/api/layout', tunnel)).status, 200)
    assert.equal((await rawReq('/', tunnel)).status, 200)
    assert.equal((await rawReq('/api/layout', { ...tunnel, authorization: '' })).status, 401)
  })
  await t.test('/mcp under a tunnel hostname: served with a token, 401 without', async () => {
    const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
    const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    assert.equal((await rawReq('/mcp', { ...h, ...tunnel }, 'POST', init)).status, 200)
    assert.equal((await rawReq('/mcp', { ...h, ...tunnel, authorization: '' }, 'POST', init)).status, 401)
  })
  await t.test('a WebSocket under a tunnel Origin opens with the token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/events?token=${TOKEN}`, { origin: tunnel.origin, headers: { host: tunnel.host } })
    const status = await new Promise((res) => { ws.on('unexpected-response', (_, r) => res(r.statusCode)); ws.on('open', () => res('open')); ws.on('error', () => res('error')) })
    ws.close()
    assert.equal(status, 'open')
  })
})

test('/pty refuses a bad sid or cmd', async () => {
  const { WebSocket } = await import(join(ROOT, 'node_modules/ws/wrapper.mjs'))
  const fatal = (qs) => new Promise((res, rej) => {
    const got = [], ws = new WebSocket(`${base.replace('http', 'ws')}/pty?${qs}&cwd=${encodeURIComponent(HOME)}&token=${TOKEN}`)
    ws.on('message', (d) => got.push(JSON.parse(String(d))))
    ws.on('close', () => res(got.at(-1))); ws.on('error', rej)
  })
  for (const [qs, reason] of [
    ['sid=s:t1&cmd=orch', 'orch runs only as orch:main'],
    ['sid=orch:main&cmd=shell', 'orch runs only as orch:main'],
    ['sid=work:wnope&cmd=worker', 'unknown worker'],
    ['sid=s:t1&cmd=worker', 'a worker runs only as work:<id>'],
    ['sid=work:w1&cmd=shell', 'a worker runs only as work:<id>'],
    [`sid=${encodeURIComponent('bad sid!')}&cmd=shell`, 'bad sid'],
    ['sid=s:t1&cmd=bogus', 'bad cmd']
  ]) assert.deepEqual(await fatal(qs), { t: 'fatal', reason }, qs)
  await alive()
})

test('a late kill frame never drops the session that replaced it', { skip: POSIX !== true && POSIX }, async () => {
  const shells = async () => (await api('/api/health')).body.sessions.shell
  const n = await shells()
  const a = await pty('kr:t1', 'shell')
  await until('the shell to start', async () => (await shells()) === n + 1)
  a.send(JSON.stringify({ t: 'kill' }))
  await until('the shell to die', () => a.msgs.some((m) => m.t === 'exit'))
  const b = await pty('kr:t1', 'shell') // its replacement, under the same sid
  await until('the replacement to start', async () => (await shells()) === n + 1)
  a.send(JSON.stringify({ t: 'kill' })) // a second kill from the old pane
  for (const junk of ['null', '[]', '7', '{"t":"i","d":7}']) a.send(junk)
  await sleep(300)
  assert.equal(await shells(), n + 1, 'the replacement is still registered')
  a.close(); b.close()
  await fetch(`${base}/api/session?sid=kr:t1`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` } })
  await alive()
})

test('sessions get their own MCP token, in a 0600 file, never in argv', { skip: POSIX !== true && POSIX }, async (t) => {
  const orch = await mcpClient()
  let worker
  try {
    freshArgs()
    const w = JSON.parse(await orch.call('dispatch', { agent: 'story-worker', repo: 'demo', branch: 'feat-tok', prompt: 'work [stay]' }))
    const argv = await claudeArgs()
    const env = readJson(CLAUDE_ENV)
    const token = mintedToken(w.sid)
    await t.test('no token is on the command line', () => {
      const all = argv.join(' ')
      for (const secret of [TOKEN, token, new URL(env.JEEVES_HOOK_URL).searchParams.get('token'), new URL(env.JEEVES_USAGE_URL).searchParams.get('token')]) assert.ok(!all.includes(secret), 'a token leaked into argv')
      assert.doesNotMatch(all, /token=|Bearer/)
      assert.equal(env.MAX_MCP_OUTPUT_TOKENS, undefined, 'only the orchestrator raises the MCP output limit')
      assert.match(argv[argv.indexOf('--mcp-config') + 1], /[\\/]\.cockpit[\\/]sessions[\\/]work\+w[0-9a-f]+\.mcp\.json$/)
      assert.match(argv[argv.indexOf('--settings') + 1], /[\\/]\.cockpit[\\/]sessions[\\/]w[0-9a-f]+\.settings\.json$/)
    })
    await t.test('the state dir is owner-only, and every file in it', () => {
      assert.equal(lstatSync(STATE).mode & 0o777, 0o700)
      assert.equal(lstatSync(sessionsDir()).mode & 0o777, 0o700)
      const files = [...readdirSync(STATE).filter((n) => n !== 'sessions').map((n) => join(STATE, n)), ...readdirSync(sessionsDir()).map((n) => join(sessionsDir(), n))]
      assert.ok(files.length > 3)
      for (const f of files) assert.equal(lstatSync(f).mode & 0o777, 0o600, f)
      assert.deepEqual(readdirSync(COCKPIT).filter((n) => n.startsWith('.jeeves-')), [], 'nothing beside server.mjs')
    })
    worker = await mcpClient(token, '/mcp?role=&sid=orch:main') // a query string grants nothing
    await t.test('the role comes from the token, not the query string', async () => {
      assert.deepEqual(await toolNames(worker), ['open_tab', 'report', 'send_tab', 'wait_tab'])
      const tab = await mcpClient(TOKEN, '/mcp?role=tab&sid=x:y')
      assert.ok((await toolNames(tab)).includes('dispatch'), 'the browser token is the full set, whatever the query says')
      await tab.client.close()
    })
    await t.test('a worker reports only as itself', async () => {
      const other = await worker.raw('report', { workId: 'wbeef00', status: 'done', summary: 'not mine' })
      assert.ok(other.isError)
      assert.match(other.content[0].text, /own workId/)
      assert.equal(await worker.call('report', { workId: w.workId, status: 'done', summary: 'mine' }), 'report recorded')
    })
    await t.test('a closed worker\'s token stops working', async () => {
      await worker.client.close().catch(() => {}); worker = null
      await orch.call('close_work', { workId: w.workId })
      const r = await rawReq('/mcp', { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, 'POST', '{}')
      assert.equal(r.status, 401)
      assert.equal(existsSync(join(sessionsDir(), w.sid.replace(':', '+') + '.mcp.json')), false)
    })
    await t.test('an unknown token is refused', async () => {
      assert.equal((await rawReq('/mcp', { authorization: 'Bearer nope', 'content-type': 'application/json' }, 'POST', '{}')).status, 401)
    })
  } finally { await worker?.client.close().catch(() => {}); await orch.client.close() }
})

test('the orchestrator runs with a fixed tool list and every tool call guarded', { skip: POSIX !== true && POSIX }, async () => {
  freshArgs()
  const ws = await pty('orch:main', 'orch')
  const argv = await claudeArgs()
  const env = readJson(CLAUDE_ENV)
  ws.close()
  assert.equal(env.MAX_MCP_OUTPUT_TOKENS, '40000')
  assert.equal(argv.filter((a) => a.startsWith('--tools')).length, 1)
  assert.equal(argv.find((a) => a.startsWith('--tools')), '--tools=Read,Grep,Glob,Edit,Write,Bash,Skill,ToolSearch,ScheduleWakeup,SendMessage,ListAgents,PushNotification')
  assert.equal(argv.at(-1), '/jeeves:start')
  const settings = readJson(argv[argv.indexOf('--settings') + 1])
  assert.equal(settings.hooks.PreToolUse[0].matcher, '.*')
  assert.doesNotMatch(JSON.stringify(settings), /token/i)
  // Claude Code runs the command through sh and blocks only on exit 2: a guard that can't run blocks too.
  const cmd = settings.hooks.PreToolUse[0].hooks[0].command, guard = join(COCKPIT, 'bin', 'guard-orchestrator.mjs')
  assert.ok(cmd.includes(guard), cmd)
  const missing = spawnSync('sh', ['-c', cmd.replace(guard, join(tmp, 'no-such-guard.mjs'))], { input: '{}', encoding: 'utf8' })
  assert.equal(missing.status, 2, missing.stderr)
  assert.match(missing.stderr, /no-such-guard/, 'node\'s own error still reaches stderr')
})

test('/events primes a new client with the layout', async () => {
  const layout = { spaces: [{ id: 'p1', tabs: [] }], pinned: [] }
  await api('/api/layout', { layout, from: 'b1' })
  const ev = await socket('/events')
  const m = await until('the layout frame', () => ev.msgs.find((x) => x.t === 'layout'))
  ev.close()
  assert.deepEqual(m, { t: 'layout', layout, from: '' })
})

test('a project.md written by hand shows up without a restart', async () => {
  mkdirSync(join(DATA, 'projects', 'byhand'), { recursive: true })
  writeFileSync(join(DATA, 'projects', 'byhand', 'project.md'), '# Project: byhand\n\n- **repo:** `acme/byhand`\n')
  assert.ok((await api('/api/config')).body.repos.some((r) => r.id === 'byhand'))
  rmSync(join(DATA, 'projects', 'byhand'), { recursive: true })
  assert.ok(!(await api('/api/config')).body.repos.some((r) => r.id === 'byhand'))
})

test('close_work removes a worktree whose project was deleted', { skip: POSIX !== true && POSIX }, async () => {
  const { client, call, raw } = await mcpClient()
  try {
    await call('create_project', { id: 'demo2', repo: 'acme/demo2', path: REPO, baseBranch: 'main' })
    const w = JSON.parse(await call('dispatch', { agent: 'story-worker', repo: 'demo2', branch: 'feat-gone', prompt: 'x' }))
    await call('delete_project', { id: 'demo2' })
    assert.ok(existsSync(w.cwd))
    await call('close_work', { workId: w.workId, removeWorktree: true })
    assert.equal(existsSync(w.cwd), false)
    assert.ok((await raw('dispatch', { agent: 'story-worker', repo: 'demo', branch: '-x', prompt: 'x' })).isError, 'a branch starting with - is refused')
  } finally { await client.close() }
})

// ── The orchestrator's typed tools ──
test('github_read', { skip: POSIX !== true && POSIX }, async (t) => {
  const { client, call, raw } = await mcpClient()
  try {
    await t.test('builds gh\'s argv itself', async () => {
      await call('github_read', { kind: 'pr', repo: 'acme/demo', number: 1 })
      const a = ghCalls().at(-1)
      assert.deepEqual(a.slice(0, 6), ['pr', 'view', '1', '--repo', 'acme/demo', '--json'])
      assert.match(a[6], /^number,title,state,isDraft,author,headRefName,baseRefName,headRefOid,/)
    })
    await t.test('the read tools are marked read-only', async () => {
      const tools = (await client.listTools()).tools
      for (const n of ['github_read', 'now', 'read_spill']) assert.equal(tools.find((x) => x.name === n).annotations?.readOnlyHint, true, n)
      assert.notEqual(tools.find((x) => x.name === 'github_write').annotations?.readOnlyHint, true)
    })
    await t.test('refuses any value starting with -', async () => {
      for (const a of [{ kind: 'pr', repo: '-R/x', number: 1 }, { kind: 'pr', repo: 'acme/demo', number: '-1' }, { kind: 'prs', repo: 'acme/demo', head: '--upload-pack=x' }, { kind: 'runs', repo: 'acme/demo', head: '-b' }, { kind: 'pr', repo: 'acme/demo', number: 1, jq: '-n' }, { kind: 'search', query: '--owner=x' }]) {
        const r = await raw('github_read', a)
        assert.ok(r.isError, JSON.stringify(a))
      }
    })
    await t.test('refuses a mutation in a graphql query', async () => {
      const before = ghCalls().length
      for (const query of ['mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }', 'query { viewer { login } } mutation { ok: closePullRequest(input: {pullRequestId: "y"}) { clientMutationId } }', 'query { a(x: "unterminated) }']) {
        assert.ok((await raw('github_read', { kind: 'graphql', query })).isError, query)
      }
      assert.equal(ghCalls().length, before, 'gh never ran')
      assert.match(await call('github_read', { kind: 'graphql', query: 'query { viewer { login } }' }), /"viewer":\{"login":"me"\}/)
    })
    await t.test('needs a repo, a number or a query where the kind takes one', async () => {
      for (const a of [{ kind: 'pr', number: 1 }, { kind: 'pr', repo: 'acme/demo' }, { kind: 'branches', repo: 'acme/demo' }, { kind: 'commits', repo: 'acme/demo', number: 1, jq: '.' }]) assert.ok((await raw('github_read', a)).isError, JSON.stringify(a))
    })
  } finally { await client.close() }
})

test('github_write touches only the user\'s own PRs', { skip: POSIX !== true && POSIX }, async () => {
  const { client, call, raw } = await mcpClient()
  try {
    assert.deepEqual(JSON.parse(await call('github_write', { action: 'retitle', repo: 'acme/demo', number: 1, key: 'ABC-7' })), { ok: true, title: '[ABC-7] fix it' })
    assert.deepEqual(ghCalls().at(-1), ['pr', 'edit', '1', '--repo', 'acme/demo', '--title=[ABC-7] fix it'])
    assert.deepEqual(JSON.parse(await call('github_write', { action: 'retitle', repo: 'acme/demo', number: 3, key: 'ABC-12' })), { ok: true, title: '[ABC-12] ABC-123 fix' }, 'ABC-12 is not ABC-123')
    assert.deepEqual(JSON.parse(await call('github_write', { action: 'retitle', repo: 'acme/demo', number: 3, key: 'ABC-123' })), { ok: true, title: 'ABC-123 fix', unchanged: true })
    const theirs = await raw('github_write', { action: 'retitle', repo: 'acme/demo', number: 2, key: 'ABC-7' })
    assert.ok(theirs.isError)
    assert.match(theirs.content[0].text, /someone's PR/)
    assert.ok((await raw('github_write', { action: 'retitle', repo: 'acme/demo', number: 1, key: '-x' })).isError)
    assert.ok((await raw('github_write', { action: 'reply_thread', threadId: '--x', body: 'hi' })).isError)
    assert.ok((await raw('github_write', { action: 'reply_thread', threadId: 'PRRT_1', body: 'hi' })).isError, 'the stand-in gh knows no such thread')
  } finally { await client.close() }
})

test('now, open_url, read_spill, write_state daily, update_config', async (t) => {
  const { client, call, raw } = await mcpClient()
  try {
    await t.test('now', async () => {
      const n = JSON.parse(await call('now'))
      assert.match(n.local, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
      assert.ok(n.iso && n.tz && Number.isInteger(n.offsetMinutes) && n.nextTickSeconds > 0, JSON.stringify(n))
    })
    await t.test('open_url takes only http(s)', async () => {
      for (const url of ['file:///etc/passwd', 'javascript:alert(1)', '-a Calculator', 'not a url']) assert.ok((await raw('open_url', { url })).isError, url)
    })
    await t.test('read_spill reads only this session\'s tool-results', async () => {
      const ctx = (await api('/api/orch/context')).body
      const dir = join(HOME, '.claude', 'projects', realpathSync(DATA).replace(/[^A-Za-z0-9]/g, '-'), ctx.sessionId, 'tool-results')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'big.txt'), 'abcdefghij')
      assert.deepEqual(JSON.parse(await call('read_spill', { path: join(dir, 'big.txt'), offset: 2, length: 3 })), { text: 'cde', offset: 2, total: 10, more: true })
      writeFileSync(join(HOME, 'secret.txt'), 'no')
      for (const path of [join(HOME, 'secret.txt'), join(dir, '..', '..', ctx.sessionId + '.jsonl'), join(dir, '..', 'x')]) assert.ok((await raw('read_spill', { path })).isError, path)
      symlinkSync(join(HOME, 'secret.txt'), join(dir, 'link.txt'))
      assert.ok((await raw('read_spill', { path: join(dir, 'link.txt') })).isError, 'a symlink out is refused')
    })
    await t.test('write_state writes daily.md', async () => {
      await call('write_state', { file: 'daily', markdown: '# daily\n' })
      assert.equal(readFileSync(join(DATA, 'daily.md'), 'utf8'), '# daily\n')
    })
    await t.test('write_state edits change rows in place, each old matching exactly once', async () => {
      await call('write_state', { file: 'daily', markdown: '- a · open\n- b · open\n' })
      await call('write_state', { file: 'daily', edits: [{ old: '- a · open', new: '- a · done' }] })
      assert.equal(readFileSync(join(DATA, 'daily.md'), 'utf8'), '- a · done\n- b · open\n')
      assert.ok((await raw('write_state', { file: 'daily', edits: [{ old: ' · ', new: 'x' }] })).isError, 'an old that matches twice')
      assert.ok((await raw('write_state', { file: 'daily', edits: [{ old: 'missing', new: 'x' }] })).isError, 'an old that matches nothing')
      assert.ok((await raw('write_state', { file: 'daily', markdown: 'x', edits: [{ old: 'a', new: 'b' }] })).isError, 'both markdown and edits')
      assert.ok((await raw('write_state', { file: 'daily' })).isError, 'neither')
      assert.equal(readFileSync(join(DATA, 'daily.md'), 'utf8'), '- a · done\n- b · open\n', 'a refused edit writes nothing')
    })
    await t.test('update_config', async () => {
      await call('update_config', { file: 'identity', set: { confluencePlansFolderId: '12345' } })
      assert.match(readFileSync(join(DATA, 'identity.md'), 'utf8'), /\*\*confluence plans folder id:\*\* `12345`/)
      assert.ok((await raw('update_config', { file: 'defaults', set: { baseBranches: ['main', '-x'] } })).isError)
      assert.ok((await raw('update_config', { file: 'identity', set: { nope: 'x' } })).isError)
    })
    await t.test('tick_snapshot full carries the index, ledgers and agents', { skip: POSIX !== true && POSIX }, async () => {
      const out = JSON.parse(await call('tick_snapshot', { full: true }))
      assert.ok(out.index.some((p) => p.id === 'demo' && p.repo === 'acme/demo'))
      assert.ok('demo' in out.ledgers)
      assert.ok(out.agents.some((a) => a.name === 'reviewer' && a.description))
    })
  } finally { await client.close() }
})

test('read-only agents can\'t push or post; the reviewer can\'t push but keeps gh', { skip: POSIX !== true && POSIX }, async (t) => {
  const { client, call } = await mcpClient()
  const launch = async (agent, branch) => {
    freshArgs()
    const w = JSON.parse(await call('dispatch', { agent, repo: 'demo', branch, prompt: 'look' }))
    const argv = await claudeArgs()
    return { w, env: readJson(CLAUDE_ENV).git, deny: readJson(argv[argv.indexOf('--settings') + 1]).permissions?.deny ?? [] }
  }
  try {
    for (const agent of ['investigator', 'planner', 'loop-verifier']) {
      await t.test(agent, async () => {
        const { w, env, deny } = await launch(agent, 'ro-' + agent)
        for (const rule of ['Bash(git push:*)', 'Bash(git commit:*)', 'Bash(gh pr comment:*)', 'Bash(gh pr review:*)', 'Bash(gh pr merge:*)', 'Bash(gh pr edit:*)', 'Bash(gh issue comment:*)', 'Bash(gh api *-X*)', 'Bash(gh api *--method*)']) assert.ok(deny.includes(rule), rule)
        // The recorded environment really stops a push from the worktree, to any remote; fetch still works.
        const run = (...a) => { try { execFileSync('git', ['-C', w.cwd, ...a], { env: { ...process.env, ...env }, stdio: 'ignore' }); return true } catch { return false } }
        assert.equal(run('push', 'origin', 'HEAD:refs/heads/' + agent), false, 'push to origin')
        assert.equal(run('push', ORIGIN, 'HEAD:refs/heads/' + agent), false, 'push to a URL')
        assert.equal(run('fetch', 'origin'), true, 'fetch')
      })
    }
    await t.test('reviewer', async () => {
      const { env, deny } = await launch('reviewer', 'ro-reviewer')
      assert.deepEqual(deny, ['Bash(git push:*)', 'Bash(git commit:*)', 'Bash(gh pr merge:*)'])
      assert.equal(env.GIT_CONFIG_VALUE_1, 'jeeves-read-only://push-disabled/')
    })
    await t.test('a story-worker is not limited', async () => {
      const { env, deny } = await launch('story-worker', 'push-story')
      assert.deepEqual([env, deny], [{}, []])
    })
  } finally { await client.close() }
})

test('a claude tab in a symlinked folder resumes its transcript', { skip: POSIX !== true && POSIX }, async () => {
  const real = join(HOME, 'real-proj'), link = join(HOME, 'link-proj')
  mkdirSync(real, { recursive: true }); symlinkSync(real, link)
  const open = async () => { freshArgs(); const ws = await pty('ln:t1', 'claude', link); const a = await claudeArgs(); ws.close(); return a }
  const first = await open()
  const id = first[first.indexOf('--session-id') + 1]
  assert.ok(id, JSON.stringify(first))
  // claude names its transcript folder after the real cwd, symlinks followed.
  const dir = join(HOME, '.claude', 'projects', realpathSync(real).replace(/[^A-Za-z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, id + '.jsonl'), '{}\n')
  const again = await open()
  assert.equal(again[again.indexOf('--resume') + 1], id)
  assert.ok(!again.includes('--session-id'))
})

test('the worker preamble says to load deferred bus tools with ToolSearch', { skip: POSIX !== true && POSIX }, async () => {
  const { client, call } = await mcpClient()
  freshArgs()
  await call('dispatch', { agent: 'story-worker', repo: 'demo', branch: 'preamble', prompt: 'x' })
  const argv = await claudeArgs()
  await client.close()
  const preamble = argv[argv.indexOf('--append-system-prompt') + 1]
  assert.match(preamble, /ToolSearch \("select:mcp__cockpit__report,SendMessage"\) — a deferred tool is not a missing one\. \(2\)/)
})

test('an agent may list Skill and Workflow among its tools', async () => {
  const r = await api('/api/agents', { op: 'save', agent: { name: 'reviewer', description: 'Mine.', tools: ['Bash', 'Skill', 'Workflow'], model: 'inherit', prompt: 'p' } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  await api('/api/agents', { op: 'delete', name: 'reviewer' })
})

test('tick_snapshot full flags repo-wide and Jira-overriding projects', { skip: POSIX !== true && POSIX }, async () => {
  const { client, call } = await mcpClient()
  const f = join(DATA, 'projects', 'demo', 'project.md'), was = readFileSync(f, 'utf8')
  try {
    writeFileSync(f, was + '\n## GitHub\n- **review scope:** `repo`\n\n## Jira\n- **QA columns:** `QA`\n')
    const row = JSON.parse(await call('tick_snapshot', { full: true })).index.find((p) => p.id === 'demo')
    assert.deepEqual([row.repoWide, row.jiraOverride], [true, true])
    writeFileSync(f, was)
    const plain = JSON.parse(await call('tick_snapshot', { full: true })).index.find((p) => p.id === 'demo')
    assert.deepEqual([plain.repoWide, plain.jiraOverride], [false, false])
  } finally { writeFileSync(f, was); await client.close() }
})

test('tick_snapshot splits Jira into a stories search and a qa search', { skip: POSIX !== true && POSIX }, async () => {
  const { client, call } = await mcpClient()
  const f = join(DATA, 'projects', 'demo', 'project.md'), was = readFileSync(f, 'utf8')
  try {
    writeFileSync(f, was + '\n## Jira\n- **project key:** `ABC`\n- **cloudId:** `c1` (acme)\n- **QA-assignee field:** `customfield_12345`\n- **QA columns:** `QA`\n')
    await api('/api/config')
    const jira = JSON.parse(await call('tick_snapshot', { full: true })).jira
    const by = Object.fromEntries(jira.map((c) => [c.section, c]))
    assert.deepEqual(Object.keys(by).sort(), ['qa', 'stories'])
    assert.match(by.stories.args.jql, /assignee = currentUser\(\)/)
    assert.doesNotMatch(by.stories.args.jql, /cf\[12345\]/)
    assert.match(by.qa.args.jql, /^project in \(ABC\) AND sprint in openSprints\(\) AND cf\[12345\] = currentUser\(\)$/)
    assert.deepEqual([by.qa.qaColumns, by.stories.qaColumns], [['QA'], undefined])
  } finally { writeFileSync(f, was); await api('/api/config'); await client.close() }
})

test('a file diff over 1 MB comes back whole',{ skip: POSIX !== true && POSIX }, async () => {
  const dir = join(HOME, 'bigdiff')
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'big.txt'), 'x'.repeat(99) + '\n'.repeat(1) + ('y'.repeat(99) + '\n').repeat(15000))
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'big')
  writeFileSync(join(dir, 'big.txt'), readFileSync(join(dir, 'big.txt'), 'utf8') + 'more\n')
  const r = await api(`/api/filediff?cwd=${encodeURIComponent(dir)}&path=big.txt`)
  assert.equal(r.body.old.length, 1500100, 'HEAD\'s side is read in full, not dropped as empty')
  assert.equal(r.body.new.length, 1500105)
})

test('create_project stores values as update_config does, one create at a time', { skip: POSIX !== true && POSIX }, async () => {
  const { client, call, raw } = await mcpClient()
  const file = join(DATA, 'projects', 'np', 'project.md')
  try {
    for (const a of [{ repo: 'not a slug' }, { repo: 'acme/np', reviewCommand: '/review `x`' }, { repo: 'acme/np', path: REPO + '\nx' }, { repo: 'acme/np', jiraKey: 'ABC\n## Evil' }, { repo: 'acme/np', seedFiles: ['.env,x'] }, { repo: 'acme/np', baseBranch: '-x' }]) {
      assert.ok((await raw('create_project', { id: 'np', path: REPO, ...a })).isError, JSON.stringify(a))
    }
    assert.equal(existsSync(file), false, 'a refused create writes nothing')
    const both = await Promise.all([1, 2].map(() => raw('create_project', { id: 'np', repo: 'acme/np', path: REPO, seedFiles: ['.env', ' .npmrc '] })))
    assert.deepEqual(both.map((r) => !!r.isError).sort(), [false, true], 'exactly one of two racing creates wins')
    assert.match(readFileSync(file, 'utf8'), /seedFiles: \.env, \.npmrc/)
    await call('delete_project', { id: 'np' })
  } finally { await client.close() }
})

test('a request body cut off mid-way leaves the server serving', async () => {
  await new Promise((res) => {
    const c = net.connect(port, '127.0.0.1', () => {
      c.write(`POST /api/layout HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\nauthorization: Bearer ${TOKEN}\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{"layout":`)
      setTimeout(() => { c.destroy(); res() }, 100)
    })
  })
  await sleep(100)
  await alive()
})

test('an upload never overwrites a file, and never the folder\'s .gitignore', async () => {
  const dir = join(HOME, 'up')
  mkdirSync(dir, { recursive: true })
  const up = (name, body) => fetch(`${base}/api/upload?cwd=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body }).then(async (r) => ({ status: r.status, body: await r.json() }))
  const paths = []
  for (const body of ['one', 'two', 'three']) paths.push((await up('notes.txt', body)).body.path)
  assert.deepEqual(paths, ['notes.txt', 'notes-1.txt', 'notes-2.txt'].map((n) => join('.jeeves-uploads', n)))
  assert.deepEqual(paths.map((p) => readFileSync(join(dir, p), 'utf8')), ['one', 'two', 'three'])
  assert.equal((await up('.env', 'a')).body.path, join('.jeeves-uploads', '.env'))
  assert.equal((await up('.env', 'b')).body.path, join('.jeeves-uploads', '.env-1'))
  for (const name of ['.gitignore', 'x/.GITIGNORE']) assert.equal((await up(name, 'oops')).status, 400, name)
  assert.equal(readFileSync(join(dir, '.jeeves-uploads', '.gitignore'), 'utf8').trim(), '*')
})

test('a killed session\'s MCP token and --mcp-config go with it', { skip: POSIX !== true && POSIX }, async () => {
  await api('/api/tab-prompt', { tabId: 'kt1abc', prompt: 'hold [stay]' })
  freshArgs()
  const ws = await pty('kt:kt1abc', 'claude')
  await claudeArgs()
  const token = mintedToken('kt:kt1abc'), f = join(sessionsDir(), 'kt+kt1abc.mcp.json')
  const mcp = () => rawReq('/mcp', { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, 'POST', '{}')
  assert.notEqual((await mcp()).status, 401)
  ws.send(JSON.stringify({ t: 'kill' }))
  await until('the token to be revoked', async () => (await mcp()).status === 401)
  assert.equal(existsSync(f), false)
  ws.close()
  await fetch(`${base}/api/session?sid=kt:kt1abc`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` } })
})

test('a worker respawns in its own worktree, whatever folder the pane names', { skip: POSIX !== true && POSIX }, async () => {
  const { client, call } = await mcpClient()
  try {
    freshArgs()
    const w = JSON.parse(await call('dispatch', { agent: 'story-worker', repo: 'demo', branch: 'respawn-cwd', prompt: 'x' }))
    await claudeArgs()
    await until('the worker to exit', async () => (await api('/api/spaces')).body.spaces.find((x) => x.workId === w.workId)?.status === 'exited')
    const ws = await pty(w.sid, 'worker', HOME) // no transcript, so a shell
    await sleep(300)
    ws.send(JSON.stringify({ t: 'i', d: 'pwd -P\r' }))
    await until('the shell to print its folder', () => ws.msgs.filter((m) => m.t === 'o').map((m) => m.d).join('').includes(realpathSync(w.cwd)))
    ws.close()
    await call('close_work', { workId: w.workId, removeWorktree: true })
  } finally { await client.close() }
})

test('sessions reach the server on loopback when it listens on every address', { skip: POSIX !== true && POSIX }, async () => {
  await stop(); await start({ HOST: '0.0.0.0' })
  try {
    try { unlinkSync(CLAUDE_ENV) } catch {}
    await api('/api/tab-prompt', { tabId: 'hs1abc', prompt: 'hold [stay]' })
    const ws = await pty('hs:hs1abc', 'claude')
    await until('a claude to run', () => existsSync(CLAUDE_ENV))
    const env = readJson(CLAUDE_ENV), self = `http://127.0.0.1:${port}/`
    for (const u of [env.JEEVES_HOOK_URL, env.JEEVES_USAGE_URL]) assert.ok(u.startsWith(self), u)
    assert.equal(readJson(join(sessionsDir(), 'hs+hs1abc.mcp.json')).mcpServers.cockpit.url, self + 'mcp')
    ws.close()
    await fetch(`${base}/api/session?sid=hs:hs1abc`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` } })
  } finally {
    try { unlinkSync(CLAUDE_ENV) } catch {} // its hook token was this run's; hook() relaunches for the next
    await stop(); await start()
  }
})

// Last: it runs the orchestrator on a one-second tick.
test('a stalled loop is flagged server-side and nudged once', { skip: POSIX !== true && POSIX }, async (t) => {
  const f = join(DATA, 'defaults.md'), had = existsSync(f) ? readFileSync(f, 'utf8') : null
  writeFileSync(f, '## Loop\n- **tick seconds:** `1`\n- **tick mid-flight seconds:** `1`\n- **tick overnight seconds:** `1`\n')
  writeFileSync(STAY, '')
  const ctx = async () => (await api('/api/orch/context')).body
  const nudges = () => (existsSync(TYPED) ? readFileSync(TYPED, 'utf8').split('Your loop has no wakeup scheduled').length - 1 : 0)
  const ws = await pty('orch:main', 'orch')
  try {
    await until('the orchestrator to run', async () => (await api('/api/health')).body.sessions.orch === 1)
    await t.test('never while it is working', async () => {
      await hook({ id: 'orch:main', status: 'working' })
      await sleep(2600)
      assert.equal((await ctx()).stalled, false)
      assert.equal(nudges(), 0)
    })
    await t.test('never just after the user typed', async () => {
      await hook({ id: 'orch:main', status: 'idle' })
      await sleep(2300)
      await api('/api/orch/input', { text: 'hello' })
      assert.equal((await ctx()).stalled, false)
    })
    await t.test('stalled once idle past two gaps, nudged once however long it lasts', async () => {
      await until('the stall', async () => (await ctx()).stalled === true, 6000)
      await until('the nudge', () => nudges() === 1, 7000)
      await sleep(6000) // past the next check
      assert.equal(nudges(), 1, 'one nudge per stall')
      assert.equal((await ctx()).stalled, true, 'the UI alert stays')
    })
  } finally {
    ws.close(); unlinkSync(STAY)
    await fetch(`${base}/api/session?sid=orch:main`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` } })
    if (had == null) rmSync(f); else writeFileSync(f, had)
  }
})
