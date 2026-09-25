// lib/loop-health.mjs: when the orchestrator's loop counts as stalled.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loopStalled } from '../lib/loop-health.mjs'

const every = 300e3, now = 10 * 3600e3
// Idle for an hour, last tick and last input long ago: stalled.
const quiet = { running: true, status: 'idle', idleSince: now - 3600e3, inputAt: 0, lastTickAt: now - 3600e3, startedAt: 0, every, now }

test('idle, untouched and past two tick gaps is stalled', () => assert.equal(loopStalled(quiet), true))
test('never while it is working or awaiting the user', () => {
  assert.equal(loopStalled({ ...quiet, status: 'working' }), false)
  assert.equal(loopStalled({ ...quiet, status: 'awaiting' }), false)
})
test('never while the user typed within a tick gap', () => assert.equal(loopStalled({ ...quiet, inputAt: now - every + 1000 }), false))
test('a long tick or conversation counts from when it went idle', () => {
  assert.equal(loopStalled({ ...quiet, idleSince: now - 2 * every + 1000 }), false)
  assert.equal(loopStalled({ ...quiet, idleSince: now - 2 * every - 1000 }), true)
})
test('a recent tick or a fresh server start is not a stall', () => {
  assert.equal(loopStalled({ ...quiet, lastTickAt: now - every }), false)
  assert.equal(loopStalled({ ...quiet, startedAt: now - every }), false)
})
test('no orchestrator, or no idle yet, is not a stall', () => {
  assert.equal(loopStalled({ ...quiet, running: false }), false)
  assert.equal(loopStalled({ ...quiet, idleSince: 0 }), false)
})
