// Cases for src/ptyLink.ts (the terminal pane's connection, queue and dead-socket state
// machine), run under a fake socket and fake timers. Bundled and run by cases.test.mjs.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPtyLink, ACK_MS, CONNECT_MS, STALE_MS, STABLE_MS, MAX_QUEUE, type SocketLike } from '../src/ptyLink'

// Fake clock + timers.
let now = 0, nextId = 1
const timers = new Map<number, { at: number; fn: () => void }>()
const advance = (ms: number) => {
  const end = now + ms
  for (;;) {
    const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
    if (!due) break
    timers.delete(due[0]); now = due[1].at; due[1].fn()
  }
  now = end
}

class FakeSocket implements SocketLike {
  readyState = 0
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  sent: any[] = []
  closed = false
  constructor(public url: string) {}
  send(d: string) { if (this.readyState !== 1) throw new Error('send on non-open'); this.sent.push(JSON.parse(d)) }
  close() { this.closed = true; this.readyState = 3 }
  // server side
  open() { this.readyState = 1; this.onopen?.() }
  msg(o: unknown) { this.onmessage?.({ data: JSON.stringify(o) }) }
  die() { this.readyState = 3; this.onclose?.() }
  inputs() { return this.sent.filter((f) => f.t === 'i') }
}

function setup() {
  now = 0; timers.clear()
  const sockets: FakeSocket[] = []
  const log = { opens: [] as boolean[], out: '' as string, exits: [] as number[], states: [] as string[], reasons: [] as (string | undefined)[] }
  const link = createPtyLink({
    url: () => 'ws://x/pty?n=' + sockets.length,
    socket: (u) => { const s = new FakeSocket(u); sockets.push(s); return s },
    now: () => now,
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id },
    clearTimeout: (id) => { timers.delete(id) },
    onOpen: (f) => log.opens.push(f),
    onOutput: (d) => { log.out += d },
    onExit: (c) => log.exits.push(c),
    onState: (s, _c, r) => { log.states.push(s); log.reasons.push(r) }
  })
  link.start()
  const last = () => sockets[sockets.length - 1]
  return { link, sockets, log, last }
}


test('queue while connecting, flush on first open', () => {
  const { link, sockets, log, last } = setup()
  link.input('ab'); link.input('c')
  assert.equal(sockets.length, 1)
  last().open()
  assert.deepEqual(log.opens, [true])
  assert.deepEqual(last().inputs().map((f) => f.d), ['abc'])
  assert.equal(last().sent.filter((f) => f.t === 'ping').length, 1)
})

test('queue across a close, flush on reconnect; keypress skips backoff', () => {
  const { link, sockets, log, last } = setup()
  last().open(); last().msg({ t: 'o', d: 'hi' })
  last().die()
  assert.equal(link.state, 'reconnecting')
  advance(999); assert.equal(sockets.length, 1) // still in 1 s backoff
  link.input('x') // user typed: reconnect now
  assert.equal(sockets.length, 2)
  link.input('y')
  last().open()
  assert.deepEqual(log.opens, [true, false])
  assert.deepEqual(last().inputs().map((f) => f.d), ['xy'])
  assert.equal(link.state, 'open')
})

test('queue is capped at MAX_QUEUE', () => {
  const { link, last } = setup()
  for (let i = 0; i < 100; i++) link.input('z'.repeat(1024))
  last().open()
  assert.equal(last().inputs()[0].d.length, MAX_QUEUE)
})

test('silence after input for ACK_MS: drop, reconnect at once, resend same n', () => {
  const { link, sockets, last } = setup()
  last().open(); last().msg({ t: 'hb' })
  link.input('ls'); link.input('\r')
  const s1 = last()
  const sent = s1.inputs()
  advance(ACK_MS - 1); assert.equal(sockets.length, 1)
  advance(2)
  assert.equal(sockets.length, 2, 'reconnected')
  assert.ok(s1.closed)
  assert.equal(s1.onmessage, null)
  link.input('!') // typed while the new socket connects
  last().open()
  const re = last().inputs()
  assert.deepEqual(re.slice(0, 2), sent, 'resent with the same sequence numbers')
  assert.equal(re[2].d, '!')
  assert.ok(re[2].n > sent[1].n)
  // the first pong confirms the resent frames, the second '!'; no further reconnects
  last().msg({ t: 'o', d: 'ls\r\n!' }); last().msg({ t: 'pong' }); last().msg({ t: 'pong' })
  advance(ACK_MS * 5)
  assert.equal(sockets.length, 2)
})

test('input answered by pongs never reconnects (steady output and typing)', () => {
  const { link, sockets, last } = setup()
  last().open()
  for (let i = 0; i < 2000; i++) { // 200 s of 100 ms steps
    if (i % 3 === 0) link.input('k')
    advance(50)
    last().msg(i % 7 ? { t: 'o', d: '.' } : { t: 'pong' })
    advance(50)
  }
  assert.equal(sockets.length, 1)
  // a program that neither echoes nor draws: only the pong answers
  link.input('secret')
  const pings = last().sent.filter((f) => f.t === 'ping').length
  assert.ok(pings > 0)
  advance(200); last().msg({ t: 'pong' }); last().msg({ t: 'pong' }) // the last ping, then the one 'secret' needed
  advance(ACK_MS * 3)
  assert.equal(sockets.length, 1)
  // steady output with no input for well past STALE_MS
  for (let i = 0; i < 100; i++) { advance(1000); last().msg({ t: 'o', d: 'tick' }) }
  link.check()
  assert.equal(sockets.length, 1)
})

test('output is not an ack: only a pong confirms input, so a half-open socket resends it', () => {
  const { link, sockets, last } = setup()
  last().open()
  link.input('ls')
  const s1 = last()
  s1.msg({ t: 'o', d: 'prompt$ ' }) // output the server sent before it read the input
  advance(ACK_MS + 1) // then the socket goes half-open: no pong
  assert.equal(sockets.length, 2, 'reconnected')
  last().open()
  assert.deepEqual(last().inputs(), s1.inputs(), 'the unconfirmed input is resent')
})

test('a pong confirms only the frames sent before its ping', () => {
  const { link, sockets, last } = setup()
  last().open()
  link.input('a') // ping covers a
  link.input('b') // sent while that ping is out
  last().msg({ t: 'pong' })
  const pings = last().sent.filter((f) => f.t === 'ping')
  assert.equal(pings.length, 2, 'a second ping covers b')
  advance(ACK_MS + 1)
  assert.equal(sockets.length, 2)
  last().open()
  assert.deepEqual(last().inputs().map((f) => f.d), ['b'])
})

test('one ping per unanswered window, not per key', () => {
  const { link, last } = setup()
  last().open()
  for (let i = 0; i < 10; i++) link.input('a')
  assert.equal(last().sent.filter((f) => f.t === 'ping').length, 1)
})

test('stuck CONNECTING is replaced after CONNECT_MS', () => {
  const { link, sockets, last } = setup()
  link.input('q')
  advance(CONNECT_MS - 1); assert.equal(sockets.length, 1)
  advance(2); assert.equal(sockets.length, 2)
  assert.ok(sockets[0].closed)
  last().open()
  assert.deepEqual(last().inputs().map((f) => f.d), ['q'])
})

test('check() catches a stuck connect when timers were throttled', () => {
  const { link, sockets } = setup()
  now += CONNECT_MS + 1 // time passes, no timers fire
  link.check()
  assert.equal(sockets.length, 2)
})

test('check(true) pings an idle socket; silence then reconnects', () => {
  const { link, sockets, last } = setup()
  last().open(); last().msg({ t: 'hb' })
  link.check(true)
  assert.equal(last().sent.filter((f) => f.t === 'ping').length, 1)
  advance(ACK_MS + 1)
  assert.equal(sockets.length, 2)
})

test('stale open socket (no hb for STALE_MS) is replaced', () => {
  const { link, sockets, last } = setup()
  last().open()
  now += STALE_MS + 1
  link.check()
  assert.equal(sockets.length, 2)
})

test('ended: no reconnect; input is dropped; revive() starts a fresh session', () => {
  const { link, sockets, log, last } = setup()
  last().open(); last().msg({ t: 'o', d: 'bye' }); last().msg({ t: 'exit', code: 1 })
  assert.equal(link.state, 'ended')
  assert.deepEqual(log.exits, [1])
  last().die() // server closes: stays ended
  advance(60000); link.check()
  assert.equal(sockets.length, 1)
  assert.equal(link.state, 'ended')
  link.input('\x1b[<0;1;1M') // a mouse report: no revive, not queued
  assert.equal(sockets.length, 1)
  assert.equal(link.state, 'ended')
  link.revive()
  assert.equal(sockets.length, 2)
  assert.equal(link.state, 'reconnecting')
  link.input('y')
  last().open()
  assert.equal(link.state, 'open')
  assert.deepEqual(log.opens, [true, false])
  assert.deepEqual(last().inputs().map((f) => f.d), ['y'])
})

test('ended while the socket stays open: revive() replaces it', () => {
  const { link, sockets, last } = setup()
  last().open(); last().msg({ t: 'exit', code: 0 })
  const s1 = last()
  link.input('\r'); link.revive()
  assert.ok(s1.closed)
  assert.equal(sockets.length, 2)
  assert.equal(s1.inputs().length, 0)
})

test('control frames only on an open socket, never queued', () => {
  const { link, last } = setup()
  link.control({ t: 'r', cols: 1, rows: 1 })
  last().open()
  assert.equal(last().sent.length, 0)
  link.control({ t: 'r', cols: 2, rows: 2 })
  assert.deepEqual(last().sent, [{ t: 'r', cols: 2, rows: 2 }])
})

test('backoff caps at 5 s', () => {
  const { sockets, last } = setup()
  for (let i = 0; i < 8; i++) { last().die(); advance(5000) }
  assert.equal(sockets.length, 9)
})

test('accept-then-close backs off instead of retrying every second', () => {
  const { sockets, last } = setup()
  const gaps: number[] = []
  for (let i = 0; i < 6; i++) {
    last().open(); last().die()
    const n = sockets.length, t0 = now
    while (sockets.length === n) advance(100)
    gaps.push(now - t0)
  }
  assert.deepEqual(gaps, [1000, 2000, 4000, 5000, 5000, 5000])
})

test('backoff restarts once a socket stayed open for STABLE_MS', () => {
  const { sockets, last } = setup()
  for (let i = 0; i < 3; i++) { last().open(); last().die(); advance(5000) }
  last().open(); advance(STABLE_MS + 1); last().die()
  const n = sockets.length
  advance(1000)
  assert.equal(sockets.length, n + 1)
})

test('fatal: failed with the reason, no retry, input dropped; revive() tries again', () => {
  const { link, sockets, log, last } = setup()
  link.input('q')
  last().open()
  last().msg({ t: 'o', d: '[cockpit: cwd not allowed]' })
  last().msg({ t: 'fatal', reason: 'cwd not allowed' })
  last().die()
  assert.equal(link.state, 'failed')
  assert.equal(log.reasons[log.reasons.length - 1], 'cwd not allowed')
  advance(60000); link.check(); link.input('x')
  assert.equal(sockets.length, 1)
  link.revive()
  assert.equal(sockets.length, 2)
  last().open()
  assert.equal(last().inputs().length, 0)
})

test('dispose stops everything', () => {
  const { link, sockets, last } = setup()
  last().open(); link.dispose()
  assert.ok(last().closed)
  advance(100000); link.input('x')
  assert.equal(sockets.length, 1)
})

