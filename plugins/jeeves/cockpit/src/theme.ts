import { useSyncExternalStore } from 'react'
import { createTheme, type MantineColorsTuple } from '@mantine/core'

// Purple-pink accent; amber stays free for the "working" session state so the two never collide.
const cockpit: MantineColorsTuple = [
  '#fce7ff', '#f7d0fb', '#eea9f2', '#e480e6', '#d95ed6',
  '#c945c2', '#b833ac', '#9c2890', '#801f74', '#66185c'
]

// Near-neutral dark with a whisper of violet (no blue cast) so the purple-pink
// accent sits with it rather than fighting it. Mantine uses dark[7] as body,
// dark[6] as surfaces, dark[5] as hover/dividers, dark[4] as borders, dark[0..1] text.
const dark: MantineColorsTuple = [
  '#e7e7ec', '#bdbdc6', '#919099', '#5e5d67', '#3a3942',
  '#2a2930', '#18171d', '#121117', '#0d0c11', '#08080b'
]

// ── Appearance: fonts from cockpit.json (via /api/config), applied at runtime ──
export type Appearance = { uiFont: string; monoFont: string; terminalFontSize: number }
export type FontKind = 'ui' | 'mono'
export const DEFAULT_APPEARANCE: Appearance = { uiFont: 'Roboto', monoFont: 'Roboto Mono', terminalFontSize: 13 }
export const CODE_FONT_SIZE = 12 // Monaco's diff view
export const FONT_NAME = /^[A-Za-z0-9 -]{1,60}$/ // what cockpit.json accepts; `system` = the OS fonts
const FALLBACK: Record<FontKind, string> = { ui: 'system-ui, -apple-system, sans-serif', mono: 'ui-monospace, Menlo, monospace' }
const WEIGHTS: Record<FontKind, string> = { ui: '400;500;600;700', mono: '400;500;600' }
const isGoogle = (family: string) => family !== 'system' && FONT_NAME.test(family)
export const fontStack = (family: string, kind: FontKind) => (isGoogle(family) ? `"${family}", ${FALLBACK[kind]}` : FALLBACK[kind])

// One <link> carries every Google Font in use: the applied UI and mono fonts plus
// any Settings is previewing. A new link replaces the old once it has loaded, so
// text never drops to the fallback in between; `linkReady` settles with it.
let applied = DEFAULT_APPEARANCE
const previews = new Map<string, FontKind>()
let linkReady: Promise<unknown> = Promise.resolve()
function syncFontLink() {
  const fams = new Map<string, FontKind>([...previews, [applied.monoFont, 'mono'], [applied.uiFont, 'ui']])
  const q = [...fams].filter(([f]) => isGoogle(f)).map(([f, k]) => `family=${f.replace(/ /g, '+')}:wght@${WEIGHTS[k]}`)
  const href = q.length ? `https://fonts.googleapis.com/css2?${q.join('&')}&display=swap` : ''
  const links = [...document.querySelectorAll<HTMLLinkElement>('link[data-ck-fonts]')]
  if ((links[links.length - 1]?.getAttribute('href') ?? '') === href) return
  const dropOthers = (keep?: HTMLLinkElement) => links.forEach((l) => { if (l !== keep) l.remove() })
  if (!href) { dropOthers(); linkReady = Promise.resolve(); return }
  const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href })
  link.dataset.ckFonts = ''
  linkReady = new Promise((done) => { link.onload = link.onerror = () => { dropOthers(link); done(null) } })
  document.head.appendChild(link)
}

// Resolves once `family` at `px` is usable, or has failed to load — measure after this.
export const whenFontLoaded = (family: string, px: number): Promise<unknown> =>
  linkReady.then(() => (isGoogle(family) ? document.fonts?.load(`${px}px "${family}"`) : undefined)).catch(() => undefined)

// Load a font for a Settings preview without applying it.
export function previewFont(family: string, kind: FontKind) {
  if (!isGoogle(family) || previews.has(family)) return
  previews.set(family, kind)
  syncFontLink()
}

// Apply an appearance: Mantine's font variables inline on :root (so they win over
// the theme's stylesheet values), the font link, and every useAppearance() reader
// (terminals, the diff view).
const listeners = new Set<() => void>()
export function applyAppearance(a: Appearance) {
  applied = a
  const root = document.documentElement.style
  root.setProperty('--mantine-font-family', fontStack(a.uiFont, 'ui'))
  root.setProperty('--mantine-font-family-headings', fontStack(a.uiFont, 'ui'))
  root.setProperty('--mantine-font-family-monospace', fontStack(a.monoFont, 'mono'))
  syncFontLink()
  listeners.forEach((l) => l())
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
export const useAppearance = () => useSyncExternalStore(subscribe, () => applied)

export const theme = createTheme({
  primaryColor: 'cockpit',
  primaryShade: { light: 6, dark: 4 },
  fontFamily: fontStack(DEFAULT_APPEARANCE.uiFont, 'ui'),
  fontFamilyMonospace: fontStack(DEFAULT_APPEARANCE.monoFont, 'mono'),
  headings: { fontFamily: fontStack(DEFAULT_APPEARANCE.uiFont, 'ui') },
  defaultRadius: 'md',
  // Trimmed from Mantine's defaults (12/14/16/18/20) — the chrome reads too large
  // for a dev tool. The terminal is sized by cockpit.json's terminalFontSize.
  fontSizes: { xs: '10.5px', sm: '12px', md: '13px', lg: '15px', xl: '18px' },
  lineHeights: { xs: '1.35', sm: '1.4', md: '1.45', lg: '1.5', xl: '1.5' },
  colors: { cockpit, dark }
})
