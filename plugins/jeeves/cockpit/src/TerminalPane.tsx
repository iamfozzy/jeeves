import { useEffect, useRef, useState } from 'react'
import { useComputedColorScheme } from '@mantine/core'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { PtyCmd } from './types'
import { withToken } from './token'
import { uploadFile } from './api'
import { fontStack, useAppearance, whenFontLoaded } from './theme'
import { createPtyLink, type LinkState, type PtyLink, type SocketLike } from './ptyLink'

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

// A keydown that lands outside every editable element goes to the active terminal.
const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .xterm'
const OVERLAY = '[role="dialog"], [role="menu"], [role="listbox"]'
const INTERACTIVE = 'button, a[href], summary, [role="button"], [role="tab"], [role="link"], [role="checkbox"], [role="switch"], [role="option"]'
// The bytes xterm would send for a key, or null for keys left unhandled. Focus
// moves to the terminal on keydown, too late for xterm to see the event itself.
function keyBytes(e: KeyboardEvent, appCursor: boolean): string | null {
  const arrow = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D' }[e.key]
  if (arrow) return (appCursor ? '\x1bO' : '\x1b[') + arrow
  const named: Record<string, string> = { Enter: '\r', Backspace: '\x7f', Tab: '\t', Escape: '\x1b' }
  if (named[e.key]) return named[e.key]
  return e.key.length === 1 ? e.key : null
}

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
  const linkRef = useRef<PtyLink | null>(null)
  const [link, setLink] = useState<{ state: LinkState; code?: number }>({ state: 'connecting' })
  const activeRef = useRef(active)
  activeRef.current = active
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

    // The URL is built per connect, so a reconnect carries a rotated token and the
    // current scheme. `cid` names this pane to the server, which drops input frames
    // it has already written when the link resends them.
    const cid = Math.random().toString(36).slice(2)
    const url = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const qs = `sid=${encodeURIComponent(sid)}&cmd=${cmd}&cwd=${encodeURIComponent(cwd)}&scheme=${schemeRef.current}&cid=${cid}`
      return withToken(`${proto}://${location.host}/pty?${qs}`)
    }

    // Fit is deferred, never synchronous. xterm's cell metrics
    // aren't ready on the same tick as open(), and the flex layout may not have
    // settled, so an immediate fit picks wrong cols/rows — tables wrap and the
    // CLI status bar clips off-screen until a resize. We fit across several
    // frames/timeouts and resend the size each time, so the PTY (and claude's
    // redraw) lands on the real dimensions without a manual browser resize.
    const refit = () => {
      if (!el || el.offsetWidth <= 0 || el.offsetHeight <= 0) return
      try { fit.fit() } catch {}
      linkRef.current?.control({ t: 'r', cols: term.cols, rows: term.rows })
    }
    refitRef.current = refit

    // The link (ptyLink.ts) keeps one live socket, queues and resends input across
    // reconnects, and reports its state to the badge. On every open after the first,
    // the server replays its buffer (or starts a new session), so reset first to
    // avoid a doubled screen.
    const link = createPtyLink({
      url,
      socket: (u) => new WebSocket(u) as unknown as SocketLike,
      now: () => Date.now(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (id) => window.clearTimeout(id),
      onOpen: (fresh) => { if (!fresh) term.reset(); refit(); if (activeRef.current) term.focus() },
      onOutput: (d) => term.write(d),
      onExit: (code) => term.write(`\r\n[session ended: ${code}]\r\n`),
      onState: (state, code) => setLink({ state, code })
    })
    linkRef.current = link
    link.start()

    const raf = requestAnimationFrame(() => { refit(); requestAnimationFrame(refit) })
    const timers = [window.setTimeout(refit, 150), window.setTimeout(refit, 450)]

    const checkTimer = window.setInterval(() => link.check(), 5000)
    // Timers are throttled in a background tab and stop across sleep, so check (and
    // ping) the moment the tab is visible or the network is back.
    const onVisible = () => { if (document.visibilityState === 'visible') link.check(true) }
    const onOnline = () => link.check(true)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    const dataSub = term.onData((d) => link.input(d))

    // A key pressed while focus sits outside any editable element (after a click on
    // a dashboard button, say) goes to the active, visible terminal. Printable keys,
    // Enter, Backspace, Tab, Escape and arrows are forwarded; other keys only move
    // focus. On a button or link, Enter, Space and Tab keep their native meaning.
    // Chords are left alone: App.tsx owns ⌘P/Ctrl+P, and the browser owns the rest.
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey) return
      if (!activeRef.current || !el.offsetWidth || !el.offsetHeight) return
      const t = e.target instanceof Element ? e.target : null
      if (t?.closest(EDITABLE) || document.querySelector(OVERLAY)) return
      if (t?.closest(INTERACTIVE) && (e.key === 'Enter' || e.key === ' ' || e.key === 'Tab')) return
      if (['Shift', 'Alt', 'Control', 'Meta', 'CapsLock', 'Dead', 'Unidentified'].includes(e.key)) return
      e.preventDefault()
      term.focus()
      const bytes = keyBytes(e, term.modes.applicationCursorKeysMode)
      if (bytes) term.input(bytes, true)
    }
    window.addEventListener('keydown', onKey)
    const titleSub = term.onTitleChange((t) => onTitleRef.current?.(t))

    const ro = new ResizeObserver(refit)
    ro.observe(el)

    return () => {
      cancelAnimationFrame(raf)
      timers.forEach((t) => clearTimeout(t))
      clearInterval(checkTimer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('keydown', onKey)
      ro.disconnect(); dataSub.dispose(); titleSub.dispose(); link.dispose(); term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Follow the app's colour scheme live, and tell the server so claude sessions it
  // launches from now on get the matching theme.
  useEffect(() => {
    const t = termRef.current
    if (t) t.options.theme = XTERM_THEMES[scheme]
    linkRef.current?.control({ t: 'scheme', v: scheme })
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
    if (paths.length) {
      linkRef.current?.input(paths.map((p) => (/\s/.test(p) ? `'${p}'` : p)).join(' ') + ' ')
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
      {(link.state === 'reconnecting' || link.state === 'ended') && (
        <div style={{
          position: 'absolute', top: 8, right: 10, zIndex: 4, pointerEvents: 'none',
          padding: '3px 9px', borderRadius: 6, border: '1px solid var(--ck-border)',
          background: 'var(--ck-surface)', boxShadow: '0 1px 3px rgba(0,0,0,.18)',
          font: '500 12px var(--mantine-font-family)',
          color: link.state === 'ended' ? 'var(--mantine-color-dimmed)' : 'var(--ck-yellow)'
        }}>
          {link.state === 'ended' ? `session ended${link.code ? ` (${link.code})` : ''} — press any key to restart` : 'reconnecting…'}
        </div>
      )}
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
