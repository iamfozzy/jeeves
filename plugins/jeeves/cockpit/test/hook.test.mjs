// hook.mjs must never fail its session: every input exits 0.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const HOOK = fileURLToPath(new URL('../bin/hook.mjs', import.meta.url))
const run = (args, stdin = '') => new Promise((res) => {
  const p = spawn(process.execPath, [HOOK, ...args], { stdio: ['pipe', 'ignore', 'ignore'] })
  p.on('close', (code) => res(code))
  p.stdin.end(stdin)
})

// Node 20 cancels subtests the parent doesn't await, so collect and await them all.
test('hook.mjs', { concurrency: true }, async (t) => {
  const runs = []
  runs.push(t.test('no args', async () => assert.equal(await run([]), 0)))
  runs.push(t.test('missing url', async () => assert.equal(await run(['orch:main', 'working']), 0)))
  runs.push(t.test('malformed url', async () => assert.equal(await run(['orch:main', 'working', 'not a url']), 0)))
  runs.push(t.test('nothing listening', async () => assert.equal(await run(['orch:main', 'working', 'http://127.0.0.1:9/api/hook']), 0)))
  runs.push(t.test('garbage stdin', async () => assert.equal(await run(['orch:main', 'working', 'http://127.0.0.1:9/api/hook'], '{nope'), 0)))
  runs.push(t.test('posts id, status and the session id from stdin, and exits 0 on a 500', async () => {
    let got
    const srv = http.createServer((req, res) => {
      let b = ''
      req.on('data', (c) => { b += c })
      req.on('end', () => { got = { url: req.url, body: JSON.parse(b) }; res.statusCode = 500; res.end() })
    })
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${srv.address().port}/api/hook?token=t`
    const code = await run(['w1', 'idle', url], JSON.stringify({ session_id: 'abc' }))
    srv.close()
    assert.equal(code, 0)
    assert.deepEqual(got, { url: '/api/hook?token=t', body: { id: 'w1', status: 'idle', sessionId: 'abc' } })
  }))
  await Promise.all(runs)
})
