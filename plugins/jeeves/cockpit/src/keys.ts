// Which keys the page-wide keydown handler (TerminalPane) forwards to the active
// terminal, and as what bytes. Pure, so it runs under node.
export interface KeyLike { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing: boolean }

// The bytes xterm would send for a key pressed while focus sits outside any
// editable element, or null to leave the key to the page. Printable keys, Enter,
// Backspace and arrows are forwarded. Chords are the app's (⌘P/Ctrl+P) or the
// browser's (Alt+Arrow is back/forward). Tab and Shift+Tab move focus; Escape is
// never forwarded, so Esc on a focused button can't interrupt claude. On a button
// or link (`onControl`), Enter and Space keep their native meaning.
export function globalKeyBytes(e: KeyLike, appCursor: boolean, onControl: boolean): string | null {
  if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return null
  const arrow = ({ ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D' } as Record<string, string>)[e.key]
  if (arrow) return (appCursor ? '\x1bO' : '\x1b[') + arrow
  if (onControl && (e.key === 'Enter' || e.key === ' ')) return null
  if (e.key === 'Enter') return '\r'
  if (e.key === 'Backspace') return '\x7f'
  return e.key.length === 1 ? e.key : null
}

// Alt+Arrow inside a terminal is a word jump: the pane sends Emacs ESC b / ESC f
// on macOS and the Ctrl+Arrow sequence elsewhere (Up/Down too), where xterm.js
// alone would send ESC[1;3<dir>. Null leaves the key to xterm.
export function altArrowBytes(e: KeyLike & { shiftKey: boolean }, mac: boolean): string | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return null
  const dir = ({ ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D' } as Record<string, string>)[e.key]
  if (!dir) return null
  if (mac) return dir === 'D' ? '\x1bb' : dir === 'C' ? '\x1bf' : null
  return `\x1b[1;5${dir}`
}
