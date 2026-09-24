// server.mjs over HTTP. It starts listening on import and keeps its state files
// (.jeeves-orch-session, .jeeves-mcp.json, .jeeves-layout.json …) next to itself, so
// the test runs a copy in a temp dir, with HOME and JEEVES_HOME pointing inside it,
// and never touches a real cockpit.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TOKEN = 'test-token'
const tmp = mkdtempSync(join(tmpdir(), 'jeeves-server-'))
const COCKPIT = join(tmp, 'cockpit')
const HOME = join(tmp, 'home')
const DATA = join(HOME, 'jeeves')
// A stand-in `claude` first on PATH: a dispatched worker records its argv here and exits.
const BIN = join(tmp, 'bin')
const CLAUDE_ARGS = join(tmp, 'claude-args.json')
let srv, base

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer().once('error', rej)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)) })
})

before(async () => {
  mkdirSync(COCKPIT, { recursive: true })
  mkdirSync(DATA, { recursive: true })
  copyFileSync(join(ROOT, 'server.mjs'), join(COCKPIT, 'server.mjs'))
  cpSync(join(ROOT, '..', 'agents'), join(tmp, 'agents'), { recursive: true }) // the built-ins, beside cockpit/ as in the plugin
  symlinkSync(join(ROOT, 'node_modules'), join(COCKPIT, 'node_modules'), 'junction')
  mkdirSync(BIN)
  writeFileSync(join(BIN, 'claude'), `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(CLAUDE_ARGS)}, JSON.stringify(process.argv.slice(2)))\n`)
  chmodSync(join(BIN, 'claude'), 0o755)
  let port
  do port = await freePort(); while (port === 4177)
  srv = spawn(process.execPath, [join(COCKPIT, 'server.mjs')], {
    cwd: COCKPIT,
    env: { ...process.env, PATH: `${BIN}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`, HOME, USERPROFILE: HOME, PORT: String(port), JEEVES_TOKEN: TOKEN, JEEVES_HOME: DATA, JEEVES_SCRATCH_ROOT: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('server did not start:\n' + log)), 10000)
    const on = (d) => { log += d; if (/Jeeves Cockpit backend/.test(log)) { clearTimeout(t); res() } }
    srv.stdout.on('data', on); srv.stderr.on('data', on)
    srv.once('exit', (code) => { clearTimeout(t); rej(new Error(`server exited ${code}:\n${log}`)) })
  })
  base = `http://127.0.0.1:${port}`
})
after(() => { srv?.kill(); rmSync(tmp, { recursive: true, force: true }) })

async function api(path, body, { token = TOKEN, raw } = {}) {
  const r = await fetch(base + path, {
    method: body === undefined && raw === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body))
  })
  return { status: r.status, body: await r.json() }
}
const alive = async () => assert.equal((await api('/api/layout')).status, 200)

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

test('a reviewer dispatch carries the project\'s review command', { skip: process.platform === 'win32' && 'the stand-in claude is a shebang script' }, async () => {
  const repo = join(HOME, 'Dev', 'demo')
  mkdirSync(repo, { recursive: true })
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' })
  git('init', '-q', '-b', 'main'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  const { Client } = await import(join(ROOT, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'))
  const { StreamableHTTPClientTransport } = await import(join(ROOT, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js'))
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }))
  try {
    const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); assert.ok(!r.isError, JSON.stringify(r.content)); return r.content[0].text }
    await call('create_project', { id: 'demo', repo: 'acme/demo', path: repo, baseBranch: 'main', reviewCommand: '/code-review high' })
    const out = JSON.parse(await call('dispatch', { agent: 'reviewer', repo: 'demo', ticket: '7', prompt: 'Review PR #7 against main.' }))
    assert.ok(out.workId, JSON.stringify(out))
    for (let i = 0; i < 50 && !existsSync(CLAUDE_ARGS); i++) await new Promise((r) => setTimeout(r, 100))
    const argv = JSON.parse(readFileSync(CLAUDE_ARGS, 'utf8'))
    assert.equal(argv.at(-1), 'Review PR #7 against main.\n\nReview command for this project: /code-review high')
    assert.equal(argv[argv.indexOf('--agent') + 1], 'reviewer')
  } finally { await client.close() }
})

test('/api/layout', async (t) => {
  await t.test('starts empty', async () => assert.deepEqual((await api('/api/layout')).body, { layout: null }))
  await t.test('saves and returns a layout', async () => {
    const layout = { spaces: [{ id: 's1', tabs: [] }], pinned: ['api'] }
    assert.deepEqual((await api('/api/layout', { layout, from: 'b1' })).body, { ok: true })
    assert.deepEqual((await api('/api/layout')).body, { layout })
    assert.deepEqual(JSON.parse(readFileSync(join(COCKPIT, '.jeeves-layout.json'), 'utf8')), layout)
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
})
