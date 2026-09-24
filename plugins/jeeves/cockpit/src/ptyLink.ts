// The connection behind one terminal pane: one WebSocket to /pty at a time,
// replaced whenever it dies, with no keystroke dropped on the way.
// - Input typed while there is no open socket is queued (up to MAX_QUEUE) and
//   flushed on the next open.
// - Input on an open socket is followed by a ping, and any server frame answers
//   it. No frame within ACK_MS means the socket is half-open: it is dropped, a new
//   one opens at once, and the unanswered input is resent on it. Input frames
//   carry a per-pane sequence number `n`, so the server skips a resent frame it
//   already wrote.
// - A socket still CONNECTING after CONNECT_MS, or silent for STALE_MS (the server
//   sends 'hb' every 15 s), is replaced.
// - After the session exits the link is 'ended'; the next keystroke reconnects,
//   which spawns (or, for claude, resumes) a fresh session. That keystroke is dropped.
// Pure: the socket constructor, clock and timers are injected, so it runs under node.

export type LinkState = 'connecting' | 'open' | 'reconnecting' | 'ended'

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
  onState: (s: LinkState, exitCode?: number) => void
}

export const ACK_MS = 3000
export const CONNECT_MS = 10000
export const STALE_MS = 40000
export const MAX_QUEUE = 64 * 1024
const MAX_BACKOFF = 5000

const OPEN = 1, CONNECTING = 0

export function createPtyLink(d: LinkDeps) {
  let ws: SocketLike | null = null
  let state: LinkState = 'connecting'
  let disposed = false, opened = false, retry = 0
  let retryTimer = 0, ackTimer = 0, connectTimer = 0
  let lastSeen = d.now(), connectAt = 0, awaitingSince = -1 // when the unanswered ping went out; -1 when none is
  let queue = '' // input not yet sent on any socket
  let unacked: { n: number; d: string }[] = [] // frames sent since the last server frame; resent on the next socket
  let seq = 0

  const setState = (s: LinkState, code?: number) => { if (s !== state || code !== undefined) { state = s; d.onState(s, code) } }
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

  // Expect a server frame within ACK_MS; the ping guarantees one from a live server
  // even when the program neither echoes nor redraws.
  const expectReply = () => {
    if (!ws || ws.readyState !== OPEN || awaitingSince >= 0) return
    awaitingSince = d.now()
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
    connectAt = d.now()
    connectTimer = d.setTimeout(() => { connectTimer = 0; if (ws === sock && sock.readyState === CONNECTING) reconnectNow() }, CONNECT_MS)
    sock.onopen = () => {
      if (ws !== sock) return
      d.clearTimeout(connectTimer); connectTimer = 0
      lastSeen = d.now()
      const fresh = !opened
      opened = true; retry = 0
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
      awaitingSince = -1; unacked = []
      d.clearTimeout(ackTimer); ackTimer = 0
      let m: { t?: string; d?: string; code?: number }
      try { m = JSON.parse(String(e.data)) } catch { return }
      if (m.t === 'o' && typeof m.d === 'string') d.onOutput(m.d)
      else if (m.t === 'exit') { queue = ''; unacked = []; d.onExit(m.code ?? 0); setState('ended', m.code ?? 0) }
    }
    sock.onclose = () => {
      if (ws !== sock) return
      drop()
      if (disposed || state === 'ended') return
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
    // Keyboard input for the PTY.
    input(s: string) {
      if (disposed) return
      if (state === 'ended') { drop(); setState('reconnecting'); connect(); return }
      if (ws && ws.readyState === OPEN) return write(s)
      queue = cap(queue + s)
      // Waiting out a backoff: the user is here now, so try at once.
      if (!ws && retryTimer) connect()
    },
    // Control frames (resize, scheme) go only on an open socket; each open resends them.
    control(o: unknown) {
      if (ws && ws.readyState === OPEN && state !== 'ended') { try { ws.send(JSON.stringify(o)) } catch {} }
    },
    // Timers are throttled in a background tab and freeze across sleep, so this
    // re-checks every deadline; call it on an interval and when the tab is shown.
    // `probe` also pings an open socket, catching one that died while nobody typed.
    check(probe = false) {
      if (disposed || state === 'ended' || !ws) return
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
