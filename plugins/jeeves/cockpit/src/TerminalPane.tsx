import { useEffect, useRef, useState } from 'react'
import { useComputedColorScheme } from '@mantine/core'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { PtyCmd } from './types'
import { withToken } from './token'
import { uploadFile } from './api'
import { fontStack, useAppearance, whenFontLoaded } from './theme'

// Terminal palettes follow the app's colour scheme. Each carries a full 16-colour
// ANSI palette tuned for its background, so shells and claude's -ansi themes (which
// draw with these colours) stay readable; the server also launches claude with the
// matching light/dark theme.
export const XTERM_THEMES = {
  dark: { background: '#0d0c11', foreground: '#d6dce4', cursor: '#d95ed6', selectionBackground: '#3a3942' },
  light: {
    background: '#ffffff', foreground: '#1f2328', cursor: '#b5179e', cursorAccent: '#ffffff', selectionBackground: '#c8d7f5',
    black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#4d2d00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
    brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f'
  }
}
// Scroll steps sent to a fullscreen claude pane per wheel event.
const WHEEL_BOOST = 3

// One PTY over one WebSocket, rendered by xterm. Mounted once per tab and kept
// alive across tab switches; `active` drives fit + focus when it becomes visible.
// `onTitle` gets the title the program sets (OSC 0/2) — claude sets its session topic.
export function TerminalPane({ sid, cwd, cmd, active, onTitle }: { sid: string; cwd: string; cmd: PtyCmd; active: boolean; onTitle?: (title: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const refitRef = useRef<() => void>(() => {})
  const termRef = useRef<Terminal | null>(null)
  const onTitleRef = useRef(onTitle)
  onTitleRef.current = onTitle
  const wsRef = useRef<WebSocket | null>(null)
  const dragDepth = useRef(0) // enter/leave counter — a bare currentTarget check leaves the overlay stuck over child nodes
  const [dragOver, setDragOver] = useState(false)
  const scheme = useComputedColorScheme('dark')
  const schemeRef = useRef(scheme)
  schemeRef.current = scheme
  const { monoFont, terminalFontSize } = useAppearance()

  useEffect(() => {
    const el = ref.current
    if (!el) return

    // claude runs full-screen on the alternate buffer and owns its own scrolling,
    // so xterm scrollback just lets you drag into stale frames behind the
    // alt-screen (garbling the TUI). Kill scrollback for the claude panes only;
    // shell and codex keep it.
    const claudePane = cmd === 'claude' || cmd === 'orch' || cmd === 'worker'
    const term = new Terminal({
      fontFamily: fontStack('system', 'mono'), // the chosen font is set once it has loaded (below)
      fontSize: terminalFontSize,
      cursorBlink: true,
      scrollback: claudePane ? 0 : 1000,
      theme: XTERM_THEMES[scheme]
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    termRef.current = term

    // In fullscreen (the alternate screen), claude owns scrolling and xterm hands
    // it one scroll step per wheel event however far the wheel moved, so a notch
    // barely moves the view. Re-dispatch each wheel event WHEEL_BOOST times in all,
    // letting xterm encode every copy for whatever mouse mode claude has set.
    if (claudePane) {
      let replaying = false
      term.attachCustomWheelEventHandler((ev) => {
        if (replaying || term.buffer.active.type !== 'alternate' || !term.element) return true
        replaying = true
        try { for (let i = 1; i < WHEEL_BOOST; i++) term.element.dispatchEvent(new WheelEvent('wheel', ev)) }
        finally { replaying = false }
        return true
      })
    }

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const qs = `sid=${encodeURIComponent(sid)}&cmd=${cmd}&cwd=${encodeURIComponent(cwd)}&scheme=${schemeRef.current}`
    const url = withToken(`${proto}://${location.host}/pty?${qs}`)
    const send = (o: unknown) => { const ws = wsRef.current; if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)) }

    // Fit is deferred, never synchronous. xterm's cell metrics
    // aren't ready on the same tick as open(), and the flex layout may not have
    // settled, so an immediate fit picks wrong cols/rows — tables wrap and the
    // CLI status bar clips off-screen until a resize. We fit across several
    // frames/timeouts and resend the size each time, so the PTY (and claude's
    // redraw) lands on the real dimensions without a manual browser resize.
    const refit = () => {
      if (!el || el.offsetWidth <= 0 || el.offsetHeight <= 0) return
      try { fit.fit() } catch {}
      send({ t: 'r', cols: term.cols, rows: term.rows })
    }
    refitRef.current = refit

    const raf = requestAnimationFrame(() => { refit(); requestAnimationFrame(refit) })
    const timers = [window.setTimeout(refit, 150), window.setTimeout(refit, 450)]

    // A dropped socket (server restart, laptop sleep, network blip) reconnects with
    // backoff. Left dead, the pane would keep showing its last frame while the
    // server reaps the detached session. On reconnect the server replays its
    // buffer (or respawns and resumes the session), so reset first to avoid a
    // doubled screen. A session that exited on its own is not respawned.
    // A socket that dies without closing never fires onclose, so the server sends a
    // heartbeat every 15 s and a socket silent for STALE_MS is dropped and replaced.
    let disposed = false, ended = false, retry = 0, retryTimer = 0, lastSeen = Date.now()
    const STALE_MS = 40000
    const connect = () => {
      const ws = new WebSocket(url)
      wsRef.current = ws
      lastSeen = Date.now()
      ws.onopen = () => {
        if (retry) term.reset()
        retry = 0
        refit()
        if (active) term.focus()
      }
      ws.onmessage = (e) => {
        lastSeen = Date.now()
        const m = JSON.parse(e.data as string)
        if (m.t === 'o') term.write(m.d)
        else if (m.t === 'exit') { ended = true; term.write(`\r\n[session ended: ${m.code}]\r\n`) }
      }
      ws.onclose = () => {
        if (disposed || ended) return
        if (!retry) term.write('\r\n[cockpit: disconnected — reconnecting…]\r\n')
        retryTimer = window.setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000))
      }
    }
    connect()
    const checkStale = () => {
      const ws = wsRef.current
      if (disposed || ended || !ws || ws.readyState !== 1 || Date.now() - lastSeen < STALE_MS) return
      ws.onclose = null; ws.close()
      term.write('\r\n[cockpit: connection went quiet — reconnecting…]\r\n')
      retry = 1
      connect()
    }
    const staleTimer = window.setInterval(checkStale, 5000)
    // Timers are throttled in a background tab, so check the moment it's visible again.
    const onVisible = () => { if (document.visibilityState === 'visible') checkStale() }
    document.addEventListener('visibilitychange', onVisible)
    const dataSub = term.onData((d) => send({ t: 'i', d }))
    const titleSub = term.onTitleChange((t) => onTitleRef.current?.(t))

    const ro = new ResizeObserver(refit)
    ro.observe(el)

    return () => {
      cancelAnimationFrame(raf)
      timers.forEach((t) => clearTimeout(t))
      disposed = true
      clearTimeout(retryTimer); clearInterval(staleTimer)
      document.removeEventListener('visibilitychange', onVisible)
      ro.disconnect(); dataSub.dispose(); titleSub.dispose(); wsRef.current?.close(); term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Follow the app's colour scheme live, and tell the server so claude sessions it
  // launches from now on get the matching theme.
  useEffect(() => {
    const t = termRef.current
    if (t) t.options.theme = XTERM_THEMES[scheme]
    const ws = wsRef.current
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'scheme', v: scheme }))
  }, [scheme])

  // Follow cockpit.json's terminal font live. The pane opens in the fallback stack
  // and takes the chosen font once it has loaded: xterm measures its cell size only
  // when fontFamily/fontSize change, so a webfont set before it loads would keep the
  // fallback's metrics. Then refit so cols/rows match the new cells.
  useEffect(() => {
    let live = true
    whenFontLoaded(monoFont, terminalFontSize).then(() => {
      const t = termRef.current
      if (!live || !t) return
      t.options.fontFamily = fontStack(monoFont, 'mono')
      t.options.fontSize = terminalFontSize
      refitRef.current()
    })
    return () => { live = false }
  }, [monoFont, terminalFontSize])

  // Becoming the visible tab: a pane hidden with display:none has zero size, so
  // its earlier fits were no-ops. Refit; then force a repaint — when the size is
  // unchanged from when it was hidden, fit() is a no-op and xterm
  // keeps showing a stale frame until a scroll, so refresh() must repaint it.
  useEffect(() => {
    if (!active) return
    const paint = () => {
      refitRef.current()
      const t = termRef.current
      if (t) { try { t.refresh(0, t.rows - 1) } catch {} }
    }
    const raf = requestAnimationFrame(() => { paint(); termRef.current?.focus() })
    const timer = window.setTimeout(paint, 120)
    return () => { cancelAnimationFrame(raf); clearTimeout(timer) }
  }, [active])

  // Only a drag carrying files is a drop target — not a tab being reordered.
  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files')
  // Drop files onto the pane → upload to <cwd>/.jeeves-uploads/ and type the
  // resulting path(s) into the session's input, ready to reference.
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault(); dragDepth.current = 0; setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (!files.length) return
    const results = await Promise.all(files.map((f) => uploadFile(cwd, f).catch(() => ({} as { path?: string }))))
    const paths = results.map((r) => r.path).filter((p): p is string => !!p)
    const ws = wsRef.current
    if (ws && ws.readyState === 1 && paths.length) {
      const text = paths.map((p) => (/\s/.test(p) ? `'${p}'` : p)).join(' ') + ' '
      ws.send(JSON.stringify({ t: 'i', d: text }))
      termRef.current?.focus()
    }
  }

  return (
    <div
      ref={wrapRef}
      onDragEnter={(e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth.current += 1; setDragOver(true) }}
      onDragOver={(e) => { if (hasFiles(e)) e.preventDefault() }}
      onDragLeave={(e) => { if (!hasFiles(e)) return; dragDepth.current -= 1; if (dragDepth.current <= 0) { dragDepth.current = 0; setDragOver(false) } }}
      onDrop={onDrop}
      style={{ position: 'relative', height: '100%', width: '100%', background: XTERM_THEMES[scheme].background, padding: '10px 12px', boxSizing: 'border-box' }}
    >
      <div ref={ref} style={{ height: '100%', width: '100%' }} />
      {dragOver && (
        <div style={{
          position: 'absolute', inset: 8, borderRadius: 8, pointerEvents: 'none',
          border: '2px dashed var(--mantine-color-cockpit-4)',
          background: 'color-mix(in srgb, var(--mantine-color-cockpit-6) 14%, transparent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5
        }}>
          <span style={{ font: '600 13px var(--mantine-font-family)', color: 'var(--mantine-color-cockpit-2)' }}>
            Drop to add to this session
          </span>
        </div>
      )}
    </div>
  )
}
