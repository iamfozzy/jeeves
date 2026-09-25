// The connection behind one terminal pane: one WebSocket to /pty at a time,
// replaced whenever it dies, with no keystroke dropped on the way.
// - Input typed while there is no open socket is queued (up to MAX_QUEUE) and
//   flushed on the next open.
// - Input on an open socket is followed by a ping. The server answers it with a
//   pong after writing every input frame sent before it, so a pong confirms those
//   frames; other frames only prove the socket is alive. No pong within ACK_MS
//   means the socket is half-open: it is dropped, a new one opens at once, and the
//   unconfirmed input is resent on it. Input frames carry a per-pane sequence
//   number `n`, so the server skips a resent frame it already wrote.
// - A socket still CONNECTING after CONNECT_MS, or silent for STALE_MS (the server
//   sends 'hb' every 15 s), is replaced.
// - A closed socket is retried with backoff (1 s doubling to MAX_BACKOFF); the
//   backoff restarts only after a socket stayed open for STABLE_MS, so a server
//   that accepts and at once closes is not hammered.
// - A 'fatal' frame (unauthorized, cwd not allowed, spawn failure) makes the link
//   'failed' with the server's reason, and it stops retrying.
// - After the session exits the link is 'ended'. Input is dropped while 'ended' or
//   'failed'; revive() reconnects, which spawns (or, for claude, resumes) a fresh session.
// Pure: the socket constructor, clock and timers are injected, so it runs under node.

export type LinkState = 'connecting' | 'open' | 'reconnecting' | 'ended' | 'failed'

export interface SocketLike {
  readyState: number
  onopen: ((e?: unknown) => void) | null
  onmessage: ((e: { data: unknown }) => void) | null
  onclose: ((e?: unknown) => void) | null
  send(data: string): void
  close(): void
}

export interface LinkDeps {
  url: () => string
  socket: (url: string) => SocketLike
  now: () => number
  setTimeout: (fn: () => void, ms: number) => number
  clearTimeout: (id: number) => void
  // A new socket is open. `fresh` is false on every open after the first, when
  // the server replays its buffer or starts a new session, so the screen resets.
  onOpen: (fresh: boolean) => void
  onOutput: (d: string) => void
  onExit: (code: number) => void
  // `reason` is the server's, for 'failed'.
  onState: (s: LinkState, exitCode?: number, reason?: string) => void
}

export const ACK_MS = 3000
export const CONNECT_MS = 10000
export const STALE_MS = 40000
export const MAX_QUEUE = 64 * 1024
export const STABLE_MS = 5000
const MAX_BACKOFF = 5000

const OPEN = 1, CONNECTING = 0

export function createPtyLink(d: LinkDeps) {
  let ws: SocketLike | null = null
  let state: LinkState = 'connecting'
  let disposed = false, opened = false, retry = 0
  let retryTimer = 0, ackTimer = 0, connectTimer = 0
  let lastSeen = d.now(), connectAt = 0, openAt = -1 // when this socket opened; -1 before it has
  let awaitingSince = -1, pingedSeq = 0 // when the unanswered ping went out (-1 when none is), and the last frame it covers
  let queue = '' // input not yet sent on any socket
  let unacked: { n: number; d: string }[] = [] // frames no pong has confirmed; resent on the next socket
  let seq = 0

  const setState = (s: LinkState, code?: number, reason?: string) => { if (s !== state || code !== undefined || reason !== undefined) { state = s; d.onState(s, code, reason) } }
  const stopped = () => state === 'ended' || state === 'failed'
  const pending = () => unacked.reduce((a, f) => a + f.d.length, 0)
  const cap = (s: string) => { const room = MAX_QUEUE - pending(); return s.length > room ? s.slice(0, Math.max(0, room)) : s }
  const clearTimers = () => { d.clearTimeout(retryTimer); d.clearTimeout(ackTimer); d.clearTimeout(connectTimer); retryTimer = ackTimer = connectTimer = 0 }

  // Detach and close the current socket; its unanswered frames wait for the next one.
  const drop = () => {
    const old = ws
    ws = null
    clearTimers()
    awaitingSince = -1
    if (old) { old.onopen = old.onmessage = old.onclose = null; try { old.close() } catch {} }
  }

  // Expect a pong within ACK_MS; it confirms every frame sent up to pingedSeq.
  const expectReply = () => {
    if (!ws || ws.readyState !== OPEN || awaitingSince >= 0) return
    awaitingSince = d.now(); pingedSeq = seq
    try { ws.send('{"t":"ping"}') } catch {}
    ackTimer = d.setTimeout(() => { ackTimer = 0; if (awaitingSince >= 0) reconnectNow() }, ACK_MS)
  }

  const sendFrame = (f: { n: number; d: string }) => { try { ws!.send(JSON.stringify({ t: 'i', d: f.d, n: f.n })) } catch {} }
  const write = (s: string) => {
    if (!s || !ws) return
    const f = { n: ++seq, d: s }
    sendFrame(f)
    unacked.push(f)
    expectReply()
  }

  const connect = () => {
    if (disposed) return
    clearTimers()
    const sock = d.socket(d.url())
    ws = sock
    connectAt = d.now(); openAt = -1
    connectTimer = d.setTimeout(() => { connectTimer = 0; if (ws === sock && sock.readyState === CONNECTING) reconnectNow() }, CONNECT_MS)
    sock.onopen = () => {
      if (ws !== sock) return
      d.clearTimeout(connectTimer); connectTimer = 0
      lastSeen = openAt = d.now()
      const fresh = !opened
      opened = true
      setState('open')
      d.onOpen(fresh)
      unacked.forEach(sendFrame)
      if (unacked.length) expectReply()
      const q = queue; queue = ''
      write(q)
    }
    sock.onmessage = (e) => {
      if (ws !== sock) return
      lastSeen = d.now()
      let m: { t?: string; d?: string; code?: number; reason?: string }
      try { m = JSON.parse(String(e.data)) } catch { return }
      if (m.t === 'o' && typeof m.d === 'string') d.onOutput(m.d)
      else if (m.t === 'pong' && awaitingSince >= 0) {
        unacked = unacked.filter((f) => f.n > pingedSeq)
        awaitingSince = -1; d.clearTimeout(ackTimer); ackTimer = 0
        if (unacked.length) expectReply()
      }
      else if (m.t === 'exit') { queue = ''; unacked = []; d.onExit(m.code ?? 0); setState('ended', m.code ?? 0) }
      else if (m.t === 'fatal') { queue = ''; unacked = []; setState('failed', undefined, String(m.reason || 'refused')) }
    }
    sock.onclose = () => {
      if (ws !== sock) return
      const stable = openAt >= 0 && d.now() - openAt > STABLE_MS
      drop()
      if (disposed || stopped()) return
      if (stable) retry = 0
      setState('reconnecting')
      retryTimer = d.setTimeout(connect, Math.min(1000 * 2 ** retry++, MAX_BACKOFF))
    }
  }

  const reconnectNow = () => {
    if (disposed) return
    drop()
    setState('reconnecting')
    connect()
  }

  return {
    get state() { return state },
    start: connect,
    // Keyboard input for the PTY; dropped while 'ended' or 'failed'.
    input(s: string) {
      if (disposed || stopped()) return
      if (ws && ws.readyState === OPEN) return write(s)
      queue = cap(queue + s)
      // Waiting out a backoff: the user is here now, so try at once.
      if (!ws && retryTimer) connect()
    },
    // Reconnect an 'ended' or 'failed' link: a fresh session, or another try.
    revive() {
      if (disposed || !stopped()) return
      drop(); setState('reconnecting'); connect()
    },
    // Control frames (resize, scheme) go only on an open socket; each open resends them.
    control(o: unknown) {
      if (ws && ws.readyState === OPEN && !stopped()) { try { ws.send(JSON.stringify(o)) } catch {} }
    },
    // Timers are throttled in a background tab and freeze across sleep, so this
    // re-checks every deadline; call it on an interval and when the tab is shown.
    // `probe` also pings an open socket, catching one that died while nobody typed.
    check(probe = false) {
      if (disposed || stopped() || !ws) return
      const t = d.now()
      if (ws.readyState === CONNECTING && t - connectAt > CONNECT_MS) return reconnectNow()
      if (ws.readyState !== OPEN) return
      if ((awaitingSince >= 0 && t - awaitingSince > ACK_MS) || t - lastSeen > STALE_MS) return reconnectNow()
      if (probe) expectReply()
    },
    dispose() { disposed = true; drop() }
  }
}

export type PtyLink = ReturnType<typeof createPtyLink>
