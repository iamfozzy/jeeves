// bin/cockpit.mjs: a spawn failure (npm not on PATH, r.status null) or a non-zero npm exit
// must fail loudly, not fall through as if it had succeeded.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = readFileSync(fileURLToPath(new URL('../bin/cockpit.mjs', import.meta.url)), 'utf8')

// A copy under its own bin/ so `root` (bin/'s parent) is a throwaway dir with no real deps,
// dist, or src — the script exits during step 1 or 2 before it would ever need them.
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-'))
  mkdirSync(join(root, 'bin'), { recursive: true })
  writeFileSync(join(root, 'bin', 'cockpit.mjs'), SCRIPT)
  return root
}
function run(root, env) {
  return new Promise((done) => {
    const p = spawn(process.execPath, [join(root, 'bin', 'cockpit.mjs'), '--no-open'], { env: { ...process.env, ...env } })
    let out = '', err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code) => done({ code, out, err }))
  })
}

test('a spawn failure (npm not on PATH) exits non-zero with a clear message', async () => {
  const root = makeRoot()
  try {
    const { code, err } = await run(root, { PATH: '' })
    assert.equal(code, 1)
    assert.match(err, /jeeves cockpit: npm ci failed/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('npm exiting non-zero is surfaced with its exit code, not swallowed', { skip: process.platform === 'win32' && 'stubs a POSIX npm shim on PATH' }, async () => {
  const root = makeRoot()
  const shims = join(root, 'shims')
  mkdirSync(shims)
  writeFileSync(join(shims, 'npm'), '#!/bin/sh\nexit 7\n')
  chmodSync(join(shims, 'npm'), 0o755)
  try {
    const { code, err } = await run(root, { PATH: shims })
    assert.equal(code, 7)
    assert.match(err, /jeeves cockpit: npm ci failed \(exit 7\)/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
