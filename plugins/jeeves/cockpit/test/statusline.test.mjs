// bin/statusline.mjs: renders the two-line status, relays the rate limits to the
// cockpit, and chains to the user's own status line.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import http from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { killTree } from '../bin/statusline.mjs'

// node-pty is a native CommonJS addon; load it through require, as server.mjs does.
const require = createRequire(import.meta.url)
const pty = require('node-pty')

const SCRIPT = fileURLToPath(new URL('../bin/statusline.mjs', import.meta.url))
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')
const now = Math.floor(Date.now() / 1000)
const INPUT = JSON.stringify({
  workspace: { current_dir: '/x/proj' }, model: { display_name: 'Opus 5.5' }, thinking: { enabled: true }, effort: { level: 'high' },
  context_window: { used_percentage: 12.6 },
  rate_limits: { five_hour: { used_percentage: 41.2, resets_at: now + 2 * 3600 + 14 * 60 + 30 }, seven_day: { used_percentage: 7, resets_at: now + 3 * 86400 + 4 * 3600 + 30 } }
})
function run(args, input, env = {}) {
  return new Promise((done) => {
    const p = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env } })
    let out = ''; p.stdout.on('data', (d) => { out += d })
    p.on('close', (code) => done({ code, out }))
    p.stdin.end(input)
  })
}

test('renders dir, model, effort, context and both limits with time to reset', async () => {
  const { code, out } = await run([], INPUT, { HOME: mkdtempSync(join(tmpdir(), 'sl-')) })
  assert.equal(code, 0)
  const [l1, l2] = plain(out).split('\n')
  assert.match(l1, /^proj:.* · Opus 5\.5 \/ high$/)
  assert.equal(l2, 'ctx 13% · 5h 41% (2h14m) · 7d 7% (3d4h)')
})

test('empty and garbage input still exit 0', async () => {
  assert.equal((await run([], '{}')).code, 0)
  assert.equal((await run([], 'not json')).code, 0)
})

test('--relay posts the limits to JEEVES_USAGE_URL, then chains to the user status line', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sl-'))
  mkdirSync(join(home, '.claude'))
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ statusLine: { command: 'echo MINE' } }))
  let got = null
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d }); req.on('end', () => { got = { url: req.url, body: JSON.parse(b) }; res.end('{}') }) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    const { code, out } = await run(['--relay'], INPUT, { HOME: home, JEEVES_USAGE_URL: `http://127.0.0.1:${srv.address().port}/api/usage?token=k` })
    assert.equal(code, 0)
    assert.equal(out.trim(), 'MINE')
    assert.equal(got.url, '/api/usage?token=k')
    assert.equal(got.body.rate_limits.five_hour.used_percentage, 41.2)
  } finally { srv.close(); rmSync(home, { recursive: true, force: true }) }
})

test('--relay renders its own line when the user status line is this script, or none', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sl-'))
  mkdirSync(join(home, '.claude'))
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ statusLine: { command: 'node ~/.claude/jeeves-statusline.mjs' } }))
  try {
    const { out } = await run(['--relay'], INPUT, { HOME: home })
    assert.match(plain(out), /ctx 13% · 5h 41%/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// A user status line that hangs, fails or prints nothing gives way to this one's own line.
for (const [name, command] of [
  ['hangs (its process group is killed after ~1.5 s)', 'sleep 30 & sleep 30'],
  ['fails', 'echo partial; exit 3'],
  ['prints nothing', 'true']
]) {
  test(`--relay renders its own line when the user status line ${name}`, { skip: process.platform === 'win32' && 'POSIX shell commands' }, async () => {
    const home = mkdtempSync(join(tmpdir(), 'sl-'))
    mkdirSync(join(home, '.claude'))
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ statusLine: { command } }))
    try {
      const t = Date.now()
      const { code, out } = await run(['--relay'], INPUT, { HOME: home })
      assert.equal(code, 0)
      assert.match(plain(out), /ctx 13% · 5h 41%/)
      assert.ok(Date.now() - t < 4000, `took ${Date.now() - t} ms`)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
}

test('run under a real TTY with nothing typed: exits with the fallback line instead of blocking on stdin', { skip: process.platform === 'win32' && 'node-pty needs a conpty build here' }, async () => {
  const term = pty.spawn(process.execPath, [SCRIPT], { name: 'xterm-256color', cols: 80, rows: 24, env: process.env })
  let out = ''
  term.onData((d) => { out += d })
  const exit = new Promise((res) => term.onExit(({ exitCode }) => res(exitCode)))
  const code = await Promise.race([
    exit,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timed out — readStdin is blocking on the TTY')), 3000))
  ])
  assert.equal(code, 0)
  assert.match(plain(out), /ctx 0%/)
})

test('killTree', { skip: process.platform === 'win32' && 'stubs a POSIX shim on PATH' }, async (t) => {
  await t.test('Windows: tree-kills by pid via taskkill, not just the immediate process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-killtree-'))
    const log = join(dir, 'calls.txt')
    writeFileSync(join(dir, 'taskkill'), `#!/bin/sh\necho "$@" >> "${log}"\n`, { mode: 0o755 })
    const realPath = process.env.PATH
    process.env.PATH = dir + delimiter + realPath
    try {
      killTree(true, 4242)
      assert.equal(readFileSync(log, 'utf8').trim(), '/PID 4242 /T /F')
    } finally { process.env.PATH = realPath; rmSync(dir, { recursive: true, force: true }) }
  })

  await t.test('POSIX: signals the negated pid (the whole process group), not taskkill', () => {
    let seen = null
    const realKill = process.kill
    process.kill = (pid, sig) => { seen = [pid, sig] }
    try { killTree(false, 4242) } finally { process.kill = realKill }
    assert.deepEqual(seen, [-4242, 'SIGKILL'])
  })
})
