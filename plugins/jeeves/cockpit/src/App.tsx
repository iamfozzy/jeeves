import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ActionIcon, AppShell, Badge, Box, Burger, Button, Group, Menu, Modal, Progress, ScrollArea, Stack, Text, Tooltip, UnstyledButton, useComputedColorScheme, useMantineColorScheme } from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'
import { IconEye, IconMoon, IconRefresh, IconSettings, IconSun } from '@tabler/icons-react'
import { Sidebar, spaceDot, WORKER_DOT } from './Sidebar'
import { Picker, type PickItem } from './Picker'
import { Settings } from './Settings'
import { SpaceView } from './SpaceView'
import { OrchestratorView } from './OrchestratorView'
import { OpenFolderModal, OpenSpaceModal } from './OpenSpaceModal'
import { TerminalPane } from './TerminalPane'
import { SpacePanel } from './SpacePanel'
import { closeWork, deleteWorktree, getConfig, getGit, getHealth, getLayout, isHttpUrl, isUnauthorized, killSession, onUnauthorized, restartOrchestrator, saveLayout } from './api'
import { CLIENT_ID, useCockpitEvents } from './events'
import { applyAppearance, DEFAULT_APPEARANCE } from './theme'
import { applyOwnActiveTabs, mergeLocalSpaces, resolveActiveSpaceId, stripActiveTabs } from './types'
import type { GitInfo, Health, Layout, OrchContext, RepoCfg, Space, Tab, TabKind, WorkerSpace } from './types'

const HEADER_H = 48
const LS_KEY = 'jeeves-cockpit-layout'
const SCRATCH_KEY = 'jeeves-cockpit-scratch'
const PINNED_KEY = 'jeeves-cockpit-pinned'       // repo ids always shown in the sidebar
const RECENT_KEY = 'jeeves-cockpit-recent-repos' // repo ids, most recently opened first
const PANEL_KEY = 'jeeves-cockpit-panel'         // git side panel shown ('1') or hidden ('0')
const MERGED_KEY = 'jeeves-cockpit-layout-merged' // this browser's spaces folded into the server's layout
const ACTIVE_TAB_KEY = 'jeeves-cockpit-active-tab' // spaceId → tabId, per browser like activeSpaceId — never synced
const STALL_KEY = 'jeeves-cockpit-stall-told'     // sessionStorage: the stall (its tick or start time) already notified
const ORCH = 'orch'
const SCRATCH = 'scratch'
const rid = () => Math.random().toString(36).slice(2, 8)

// The Scratchpad: a pinned Space rooted at the scratch root (home dir), opened
// first with one terminal. Its tabs persist; its cwd is injected at render.
function loadScratch(): Space {
  const base = { id: SCRATCH, repoId: '', name: 'Scratchpad', cwd: '' }
  try {
    const p = JSON.parse(localStorage.getItem(SCRATCH_KEY) || '')
    if (Array.isArray(p?.tabs)) return { ...base, tabs: p.tabs, activeTabId: p.activeTabId || p.tabs[0]?.id || '' }
  } catch {}
  const id = rid()
  return { ...base, tabs: [{ id, kind: 'shell' }], activeTabId: id }
}

function loadIds(key: string): string[] {
  try {
    const p = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(p) ? p.filter((x) => typeof x === 'string') : []
  } catch { return [] }
}
function saveIds(key: string, ids: string[]) {
  try { localStorage.setItem(key, JSON.stringify(ids)) } catch {}
}

function loadActiveTabs(): Record<string, string> {
  try {
    const p = JSON.parse(localStorage.getItem(ACTIVE_TAB_KEY) || '{}')
    return p && typeof p === 'object' ? p : {}
  } catch { return {} }
}

function loadLayout(): { spaces: Space[]; activeSpaceId: string } {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      const p = JSON.parse(raw)
      return { spaces: Array.isArray(p.spaces) ? p.spaces : [], activeSpaceId: p.activeSpaceId || ORCH }
    }
  } catch {}
  return { spaces: [], activeSpaceId: ORCH }
}

export function App() {
  const unauthorized = useSyncExternalStore(onUnauthorized, isUnauthorized)
  const [repos, setRepos] = useState<RepoCfg[]>([])
  const [home, setHome] = useState('')
  const [scratchRoot, setScratchRoot] = useState('')
  const [scratch, setScratch] = useState<Space>(loadScratch)
  const [spaces, setSpaces] = useState<Space[]>(() => loadLayout().spaces)
  const [activeSpaceId, setActiveSpaceId] = useState<string>(() => loadLayout().activeSpaceId)
  const [gitBySpace, setGitBySpace] = useState<Record<string, GitInfo>>({})
  const [openRepo, setOpenRepo] = useState<RepoCfg | null>(null)
  const [openFolder, setOpenFolder] = useState(false)
  const [closingWorker, setClosingWorker] = useState<WorkerSpace | null>(null)
  const [closeErr, setCloseErr] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pinned, setPinned] = useState<string[]>(() => loadIds(PINNED_KEY))
  const [recent, setRecent] = useState<string[]>(() => loadIds(RECENT_KEY))
  // Which tab is active in a space is per-browser, like activeSpaceId — never part
  // of the synced layout. Kept in a ref (not state): it's read inside patchSpace's
  // updater and written straight to storage, never needs its own render.
  const activeTabsRef = useRef<Record<string, string>>(loadActiveTabs())
  const setActiveTab = (spaceId: string, tabId: string) => {
    activeTabsRef.current = { ...activeTabsRef.current, [spaceId]: tabId }
    try { localStorage.setItem(ACTIVE_TAB_KEY, JSON.stringify(activeTabsRef.current)) } catch {}
  }
  // The git side panel's shown/hidden state: one setting for every space and worker.
  const [panelOpen, setPanelOpen] = useState(() => { try { return localStorage.getItem(PANEL_KEY) !== '0' } catch { return true } })
  const togglePanel = () => setPanelOpen((v) => { const n = !v; try { localStorage.setItem(PANEL_KEY, n ? '1' : '0') } catch {}; return n })
  // 'repos' = the sidebar's "Open space…" picker; 'switch' = the ⌘P quick switcher.
  const [picker, setPicker] = useState<{ mode: 'repos' | 'switch'; open: boolean }>({ mode: 'repos', open: false })
  const { surface, workers, workersLoaded, context, sessions, configNonce, openCmds, spaceCmds, remoteLayout, connectNonce, reminders } = useCockpitEvents()
  const { setColorScheme } = useMantineColorScheme()
  const scheme = useComputedColorScheme('dark')
  // Below the sm breakpoint the sidebar is a full-screen drawer behind the header's burger;
  // picking a view (or opening a space from anywhere) closes it.
  const [navOpen, { toggle: toggleNav, close: closeNav }] = useDisclosure(false)
  useEffect(closeNav, [activeSpaceId])

  // Refetch on mount and whenever config changes server-side (a project created /
  // updated / deleted, a cockpit.json save). The appearance (fonts) applies at once.
  useEffect(() => {
    getConfig()
      .then((c) => { setRepos(c.repos); setHome(c.home); setScratchRoot(c.scratchRoot || c.home); applyAppearance(c.appearance ?? DEFAULT_APPEARANCE) })
      .catch(() => { setRepos([]); applyAppearance(DEFAULT_APPEARANCE) })
  }, [configNonce])

  // Persist the scratchpad's tabs (its cwd is injected at render, not stored).
  useEffect(() => { try { localStorage.setItem(SCRATCH_KEY, JSON.stringify(scratch)) } catch {} }, [scratch])

  // Open spaces the orchestrator asks for (open_space tool). Process each command
  // id once; wait for its repo to be known. Borrowed, so closing never deletes the
  // worktree the user asked to open. The space's id is the command's spaceRef and
  // its tab id the server's, so every browser builds the same space and sids.
  const openedCmds = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const c of openCmds) {
      if (openedCmds.current.has(c.id)) continue
      const repo = c.repoId ? repos.find((r) => r.id === c.repoId) : null // '' = a folder space
      if (c.repoId && !repo) continue
      openedCmds.current.add(c.id)
      if (spaces.some((s) => s.openId === c.id)) continue // another browser opened it
      openSpace(repo ?? null, c.cwd, c.label, c.kind, true, c.id, c.tab)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCmds, repos])

  // add_tab / close_space, targeting a space by its openId (the spaceRef
  // open_space returned) or its id (open_tab from a claude tab). An add_tab with
  // `open` opens its space when none has that spaceRef; a second command for the
  // same spaceRef waits for the next pass, once that space is in state. An add_tab
  // to the Scratchpad also shows it. close_tab drops a tab the server already ended,
  // wherever it is. Each command id is processed once.
  const ranSpaceCmds = useRef<Set<string>>(new Set())
  useEffect(() => {
    const opening = new Set<string>()
    for (const c of spaceCmds) {
      if (ranSpaceCmds.current.has(c.id)) continue
      if (c.t === 'close_tab') {
        ranSpaceCmds.current.add(c.id)
        const holder = [scratch, ...spaces].find((s) => s.tabs.some((t) => t.id === c.tabId))
        if (holder) dropTab(holder.id, c.tabId!)
        continue
      }
      const target = c.spaceId === SCRATCH ? scratch : spaces.find((s) => (c.spaceId ? s.id === c.spaceId : s.openId === c.spaceRef))
      if (!target) {
        const repo = c.open && (c.open.repoId ? repos.find((r) => r.id === c.open!.repoId) : null)
        if (c.t !== 'add_tab' || !c.open || repo === undefined || !c.spaceRef || opening.has(c.spaceRef)) continue
        ranSpaceCmds.current.add(c.id)
        opening.add(c.spaceRef)
        openSpace(repo, c.open.cwd, c.open.label, c.kind ?? 'claude', true, c.spaceRef, c.tab, false)
        continue
      }
      ranSpaceCmds.current.add(c.id)
      if (c.t === 'add_tab') { addTab(target.id, c.kind ?? 'claude', c.tab); if (target.id === SCRATCH) setActiveSpaceId(SCRATCH) }
      else removeSpace(target.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceCmds, spaces, scratch, repos])

  useEffect(() => saveIds(PINNED_KEY, pinned), [pinned])
  useEffect(() => saveIds(RECENT_KEY, recent), [recent])
  const togglePin = (id: string) => setPinned((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))

  // ⌘P (any focus, terminals included: Cmd chords never reach the PTY; overrides the
  // browser's print) or Ctrl+P (outside terminals only, so readline/claude keep Ctrl+P
  // as previous-history)
  // toggles the quick switcher. Capture phase, so xterm never sees the chord.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'p' || e.altKey || e.shiftKey) return
      const inTerminal = e.target instanceof Element && !!e.target.closest('.xterm')
      if (!e.metaKey && !(e.ctrlKey && !inTerminal)) return
      e.preventDefault()
      e.stopPropagation()
      setPicker((p) => (p.open && p.mode === 'switch' ? { ...p, open: false } : { mode: 'switch', open: true }))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Persist the layout so a reload restores spaces/tabs (their PTYs survive on the backend).
  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ spaces, activeSpaceId })) } catch {}
  }, [spaces, activeSpaceId])

  // The layout is the server's (/api/layout), shared by every browser and origin;
  // localStorage only paints it before the fetch lands. Nothing is saved until the
  // fetch has, so a stale local copy never overwrites the server's. `synced` holds
  // the last layout read from or sent to the server (activeTabId blanked out, since
  // that's per-browser and never part of what two browsers agree is "the same
  // layout"), so applying one — or switching a tab — never triggers an echoing save.
  const synced = useRef('')
  const [hydrated, setHydrated] = useState(false)
  // Whether THIS connection's own resync has landed yet: set false the moment the
  // socket (re)opens, true once its `layout` push (or the initial REST fetch) has
  // been applied. Saving before that could clobber the server with a locally-drifted
  // copy from before the drop.
  const [layoutSynced, setLayoutSynced] = useState(false)
  const seenConnect = useRef(0)
  useEffect(() => {
    if (connectNonce === seenConnect.current) return
    seenConnect.current = connectNonce
    setLayoutSynced(false)
  }, [connectNonce])
  function applyLayout(l: Layout) {
    synced.current = JSON.stringify({ spaces: stripActiveTabs(l.spaces), scratch: stripActiveTabs([l.scratch])[0], pinned: l.pinned, recent: l.recent })
    setSpaces(applyOwnActiveTabs(l.spaces, activeTabsRef.current))
    setScratch(applyOwnActiveTabs([l.scratch], activeTabsRef.current)[0])
    setPinned(l.pinned); setRecent(l.recent)
    setActiveSpaceId((a) => (a === ORCH || a === SCRATCH || a.startsWith('work:') || l.spaces.some((s) => s.id === a) ? a : ORCH))
    setLayoutSynced(true)
  }
  // A browser's first sync folds in the spaces only it knows (they lived in its own
  // localStorage, per origin); after that the server's layout wins outright.
  useEffect(() => {
    getLayout().then(({ layout }) => {
      let first = false
      try { first = !localStorage.getItem(MERGED_KEY); localStorage.setItem(MERGED_KEY, '1') } catch {}
      if (!layout) return // this browser's layout seeds the server
      if (!first) return applyLayout(layout)
      const mine = mergeLocalSpaces(spaces, layout.spaces)
      applyLayout(layout)
      if (mine.length) setSpaces((prev) => [...prev, ...mine])
    }).catch(() => {}).finally(() => setHydrated(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // The server pushes the current layout on every connect (so a reconnect resyncs)
  // and again whenever another browser saves; both land here.
  useEffect(() => { if (remoteLayout) applyLayout(remoteLayout) }, [remoteLayout])
  useEffect(() => {
    if (!hydrated || !layoutSynced) return
    const l: Layout = { spaces, scratch, pinned, recent }
    const j = JSON.stringify({ spaces: stripActiveTabs(l.spaces), scratch: stripActiveTabs([l.scratch])[0], pinned: l.pinned, recent: l.recent })
    if (j === synced.current) return
    synced.current = j
    saveLayout(l, CLIENT_ID).catch(() => {})
  }, [hydrated, layoutSynced, spaces, scratch, pinned, recent])

  // A work: view outlives its worker until the first 'spaces' message confirms
  // whether it's still dispatched — closing it elsewhere (or a stale reload) must
  // fall back to the orchestrator once we actually know, not guess.
  useEffect(() => {
    setActiveSpaceId((a) => resolveActiveSpaceId(a, workers, workersLoaded, ORCH))
  }, [workers, workersLoaded])

  const gitKey = spaces.map((s) => s.id + ':' + s.cwd).join('|')
  useEffect(() => {
    let cancelled = false
    let inFlight = false // skip a tick if the previous round hasn't settled
    const poll = async () => {
      if (inFlight) return
      inFlight = true
      // allSettled: one space's git call failing (a deleted worktree, a hiccup)
      // must not blank every other space's badge for the tick.
      const settled = await Promise.allSettled(spaces.map((s) => getGit(s.cwd)))
      if (!cancelled) {
        setGitBySpace((prev) => {
          const next = { ...prev }
          spaces.forEach((s, i) => { const r = settled[i]; if (r.status === 'fulfilled') next[s.id] = r.value })
          return next
        })
      }
      inFlight = false
    }
    poll()
    const iv = window.setInterval(poll, 5000)
    return () => { cancelled = true; clearInterval(iv) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gitKey])

  // Runs `fn`, then — if it changed which tab is active — records that as this
  // browser's own choice for the space, so a later synced layout can't overrule it.
  const patchSpace = (id: string, fn: (s: Space) => Space) => {
    if (id === SCRATCH) {
      setScratch((s) => { const next = fn(s); if (next.activeTabId !== s.activeTabId) setActiveTab(SCRATCH, next.activeTabId); return next })
      return
    }
    setSpaces((prev) => prev.map((s) => {
      if (s.id !== id) return s
      const next = fn(s)
      if (next.activeTabId !== s.activeTabId) setActiveTab(id, next.activeTabId)
      return next
    }))
  }

  // `first` fixes the first tab (a server-launched child tab); focus=false opens
  // the space without switching to it. A server-opened space (`openId`) takes that
  // as its id, so every browser opening it builds the same space.
  // `repo` null opens a folder space: any folder, no repo, git panel only if it's a git repo.
  function openSpace(repo: RepoCfg | null, cwd: string, label: string, kind: TabKind = 'shell', borrowed = false, openId?: string, first?: Tab, focus = true) {
    const dup = spaces.filter((s) => s.name === label || s.name.startsWith(label + ' ·')).length
    const tab = first ?? { id: rid(), kind }
    const id = openId ?? rid()
    const space: Space = {
      id,
      repoId: repo?.id ?? '',
      name: dup ? `${label} · ${dup + 1}` : label,
      cwd,
      tabs: [tab],
      activeTabId: tab.id,
      borrowed,
      openId
    }
    setActiveTab(id, tab.id) // this browser's own choice for a space every browser may end up sharing
    setSpaces((s) => (s.some((x) => x.id === space.id) ? s : [...s, space]))
    if (focus) setActiveSpaceId(space.id)
    if (repo) setRecent((r) => [repo.id, ...r.filter((x) => x !== repo.id)].slice(0, 50))
  }

  // Picker rows: every repo (recently opened first, then by slug) opens the
  // open-space flow; the quick switcher adds the fixed views, spaces and workers.
  function pickerItems(): PickItem[] {
    const recency = (id: string) => { const i = recent.indexOf(id); return i < 0 ? Infinity : i }
    const repoItems: PickItem[] = [...repos]
      .sort((a, b) => recency(a.id) - recency(b.id) || a.slug.localeCompare(b.slug))
      .map((r) => ({
        key: 'repo:' + r.id, group: picker.mode === 'switch' ? 'Open a space in' : 'Repos',
        label: r.slug, sub: r.path, match: `${r.slug} ${r.id}`,
        pinned: pinned.includes(r.id), onTogglePin: () => togglePin(r.id), onPick: () => setOpenRepo(r)
      }))
    if (picker.mode !== 'switch') return repoItems
    const slug = (id: string) => repos.find((r) => r.id === id)?.slug ?? id
    return [
      { key: ORCH, group: 'Go to', label: 'Jeeves', sub: 'orchestrator · all repos', match: 'jeeves orchestrator', dot: 'var(--mantine-color-cockpit-4)', onPick: () => setActiveSpaceId(ORCH) },
      { key: SCRATCH, group: 'Go to', label: 'Scratchpad', sub: 'home · terminals', match: 'scratchpad home terminals', onPick: () => setActiveSpaceId(SCRATCH) },
      ...spaces.map((s) => ({
        key: 'space:' + s.id, group: 'Spaces', label: s.name,
        sub: s.repoId ? `${slug(s.repoId)} · ${gitBySpace[s.id]?.branch ?? '…'}` : s.cwd,
        match: `${s.name} ${s.repoId ? slug(s.repoId) : s.cwd} ${gitBySpace[s.id]?.branch ?? ''}`,
        dot: spaceDot(s, sessions).color, onPick: () => setActiveSpaceId(s.id)
      })),
      ...workers.map((w) => ({
        key: 'work:' + w.workId, group: 'Agents', label: `${w.agent} · ${w.ticket || w.branch}`,
        sub: `${w.repoSlug} · ${w.status}`, match: `${w.agent} ${w.ticket ?? ''} ${w.branch} ${w.repoSlug}`,
        dot: WORKER_DOT[w.status], onPick: () => setActiveSpaceId('work:' + w.workId)
      })),
      ...repoItems
    ]
  }

  // Open your own multi-tab space in a dispatched worker's worktree, to
  // investigate its changes independently of the worker's own session.
  function investigateWorker(w: WorkerSpace) {
    const repo = repos.find((r) => r.id === w.repo)
    if (repo) openSpace(repo, w.cwd, w.ticket || w.branch, 'claude', true)
  }

  // A worker's `status` field is semantic (set by its own `report()` call) and
  // doesn't necessarily mean the underlying process has actually exited — a
  // worker can report `done` and keep running past its assigned task.
  // `sessions[sid]` is the hook-driven signal for the PTY itself; 'exited' there
  // means the process genuinely ended. That's the real "a story worker ended"
  // moment — prompt then, once per worker, rather than leaving it to sit in the
  // dispatched list until someone happens to notice and close it by hand.
  const promptedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (closingWorker) return // one at a time
    for (const w of workers) {
      if (sessions[w.sid] !== 'exited') continue
      if (promptedRef.current.has(w.workId)) continue
      promptedRef.current.add(w.workId)
      setClosingWorker(w)
      setCloseErr(null)
      break // one at a time
    }
  }, [workers, sessions, closingWorker])

  async function confirmCloseWorker(removeWt: boolean, force: boolean) {
    if (!closingWorker) return
    setDeleting(true)
    try {
      const r = await closeWork(closingWorker.workId, removeWt, force)
      if (r.error) { setCloseErr(r.error); return } // dirty worktree → offer force
      if (activeSpaceId === 'work:' + closingWorker.workId) setActiveSpaceId(ORCH)
      setClosingWorker(null) // the bus drop pushes a spaces update that removes it from the UI
    } catch (e) {
      setCloseErr(e instanceof Error ? e.message : 'failed to close')
    } finally {
      setDeleting(false)
    }
  }

  function removeSpace(id: string) {
    const sp = spaces.find((s) => s.id === id)
    if (sp) sp.tabs.forEach((t) => killSession(`${id}:${t.id}`))
    setSpaces((prev) => {
      const next = prev.filter((s) => s.id !== id)
      if (activeSpaceId === id) setActiveSpaceId(next.length ? next[next.length - 1].id : ORCH)
      return next
    })
  }

  // Whether closing a space can also delete its worktree: only one it owns — never a
  // borrowed one (investigating a worker's worktree), a dispatched worker's (however
  // it was opened) or the repo's main checkout.
  function ownsWorktree(sp: Space) {
    return !!sp.repoId && !sp.borrowed && !workers.some((w) => w.cwd === sp.cwd) && sp.cwd !== repos.find((r) => r.id === sp.repoId)?.path
  }

  // Close a space, deleting its worktree first when asked. Returns the server's
  // refusal (e.g. uncommitted changes) so the confirm can offer a force delete.
  async function closeSpace(id: string, worktree: 'keep' | 'delete' | 'force'): Promise<string | null> {
    const sp = spaces.find((s) => s.id === id)
    if (sp && worktree !== 'keep') {
      const r = await deleteWorktree(sp.repoId, sp.cwd, worktree === 'force')
      if (r.error) return r.error
    }
    removeSpace(id)
    return null
  }

  function addTab(spaceId: string, kind: TabKind, tab: Tab = { id: rid(), kind }) {
    patchSpace(spaceId, (s) => (s.tabs.some((t) => t.id === tab.id) ? s : { ...s, tabs: [...s.tabs, tab], activeTabId: tab.id }))
  }
  function closeTab(spaceId: string, tabId: string) {
    killSession(`${spaceId}:${tabId}`)
    dropTab(spaceId, tabId)
  }
  // Remove a tab from its space; its session is ended separately.
  function dropTab(spaceId: string, tabId: string) {
    patchSpace(spaceId, (s) => {
      const tabs = s.tabs.filter((t) => t.id !== tabId)
      const activeTabId = s.activeTabId === tabId ? tabs[tabs.length - 1]?.id ?? '' : s.activeTabId
      return { ...s, tabs, activeTabId }
    })
  }
  function activateTab(spaceId: string, tabId: string) {
    patchSpace(spaceId, (s) => ({ ...s, activeTabId: tabId }))
  }
  // Move a tab to just before or after another in the same space.
  function moveTab(spaceId: string, tabId: string, targetId: string, after: boolean) {
    if (tabId === targetId) return
    patchSpace(spaceId, (s) => {
      const moving = s.tabs.find((t) => t.id === tabId)
      const rest = s.tabs.filter((t) => t.id !== tabId)
      const i = rest.findIndex((t) => t.id === targetId)
      if (!moving || i < 0) return s
      rest.splice(after ? i + 1 : i, 0, moving)
      return { ...s, tabs: rest }
    })
  }
  function renameTab(spaceId: string, tabId: string, title: string) {
    const t = title.trim()
    patchSpace(spaceId, (s) => ({ ...s, tabs: s.tabs.map((tab) => (tab.id === tabId ? { ...tab, title: t || undefined } : tab)) }))
  }

  async function doRestart() {
    if (!window.confirm('Restart the orchestrator? Relaunches it on a fresh session with the current settings — durable state lives in state.md, so nothing is lost.')) return
    try {
      const r = await restartOrchestrator()
      if (r.error) window.alert('Restart failed: ' + r.error)
    } catch (e) {
      window.alert('Restart failed: ' + (e instanceof Error ? e.message : 'unknown error'))
    }
  }

  // Every request past a 401 fails the same way (a dead or stale token) — show one
  // fixed message instead of a UI that's silently broken everywhere at once.
  if (unauthorized) {
    return (
      <Box style={{ height: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Text size="sm" c="dimmed">unauthorized — reopen the cockpit from its token URL</Text>
      </Box>
    )
  }

  return (
    <>
    <AppShell header={{ height: HEADER_H }} navbar={{ width: 300, breakpoint: 'sm', collapsed: { mobile: !navOpen } }} padding={0}>
      <AppShell.Header>
        <Group h="100%" px="md" gap="sm" wrap="nowrap">
          <Burger opened={navOpen} onClick={toggleNav} hiddenFrom="sm" size="sm" aria-label="Toggle navigation" />
          <img src="/brand/jeeves-icon.svg" alt="" width={24} height={24} style={{ display: 'block' }} />
          <Text fw={600} size="sm" visibleFrom="sm">Jeeves Cockpit</Text>
          <Group ml="auto" gap="sm" wrap="nowrap">
            <OrchControl ctx={context} onRestart={doRestart} />
            <WatchingIndicator repos={repos} />
            <Tooltip label={scheme === 'dark' ? 'Light mode' : 'Dark mode'} openDelay={300} withArrow>
              <ActionIcon variant="subtle" color="gray" onClick={() => setColorScheme(scheme === 'dark' ? 'light' : 'dark')} aria-label="Toggle colour scheme">
                {scheme === 'dark' ? <IconSun size={17} /> : <IconMoon size={17} />}
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Settings" openDelay={300} withArrow>
              <ActionIcon variant="subtle" color="gray" onClick={() => setSettingsOpen(true)} aria-label="Settings">
                <IconSettings size={17} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p={0} style={{ display: 'flex', flexDirection: 'column' }}>
        <ScrollArea style={{ flex: 1, minHeight: 0 }}>
          <Sidebar
            repos={repos}
            spaces={spaces}
            workers={workers}
            sessionStatus={sessions}
            activeSpaceId={activeSpaceId}
            gitBySpace={gitBySpace}
            orchestratorActive={activeSpaceId === ORCH}
            onSelectOrchestrator={() => { setActiveSpaceId(ORCH); closeNav() }}
            scratchpadActive={activeSpaceId === SCRATCH}
            onSelectScratchpad={() => { setActiveSpaceId(SCRATCH); closeNav() }}
            orchStatus={context?.status}
            scratchTabs={scratch.tabs.length}
            pinned={pinned}
            onTogglePin={togglePin}
            onOpenPicker={() => setPicker({ mode: 'repos', open: true })}
            onOpenSpaceRequest={setOpenRepo}
            onOpenFolderRequest={() => setOpenFolder(true)}
            onSelectSpace={(id) => { setActiveSpaceId(id); closeNav() }}
            ownsWorktree={ownsWorktree}
            onCloseSpace={closeSpace}
            onOpenWorkerSpace={investigateWorker}
            onCloseWorker={(w) => { setClosingWorker(w); setCloseErr(null) }}
          />
        </ScrollArea>
        <ConnectedStatus />
      </AppShell.Navbar>

      <AppShell.Main>
        <div style={{ height: `calc(100dvh - ${HEADER_H}px)`, position: 'relative' }}>
          {/* Everything stays mounted; inactive views are hidden so PTY sessions survive a switch. */}
          {home && (
            <div style={{ position: 'absolute', inset: 0, display: activeSpaceId === ORCH ? 'block' : 'none' }}>
              <OrchestratorView home={home} repos={repos} surface={surface} workers={workers} reminders={reminders} active={activeSpaceId === ORCH} />
            </div>
          )}
          {scratchRoot && (
            <div style={{ position: 'absolute', inset: 0, display: activeSpaceId === SCRATCH ? 'block' : 'none' }}>
              <SpaceView
                space={{ ...scratch, cwd: scratchRoot }}
                spaceActive={activeSpaceId === SCRATCH}
                panel={false}
                panelOpen={panelOpen}
                onTogglePanel={togglePanel}
                onActivateTab={(tabId) => activateTab(SCRATCH, tabId)}
                onAddTab={(kind) => addTab(SCRATCH, kind)}
                onCloseTab={(tabId) => closeTab(SCRATCH, tabId)}
                onRenameTab={(tabId, title) => renameTab(SCRATCH, tabId, title)}
                onMoveTab={(tabId, targetId, after) => moveTab(SCRATCH, tabId, targetId, after)}
              />
            </div>
          )}
          {spaces.map((s) => (
            <div key={s.id} style={{ position: 'absolute', inset: 0, display: s.id === activeSpaceId ? 'block' : 'none' }}>
              <SpaceView
                space={s}
                panel={!!s.repoId || !!gitBySpace[s.id]?.git}
                spaceActive={s.id === activeSpaceId}
                panelOpen={panelOpen}
                onTogglePanel={togglePanel}
                onActivateTab={(tabId) => activateTab(s.id, tabId)}
                onAddTab={(kind) => addTab(s.id, kind)}
                onCloseTab={(tabId) => closeTab(s.id, tabId)}
                onRenameTab={(tabId, title) => renameTab(s.id, tabId, title)}
                onMoveTab={(tabId, targetId, after) => moveTab(s.id, tabId, targetId, after)}
              />
            </div>
          ))}
          {workers.map((w) => {
            const wActive = activeSpaceId === 'work:' + w.workId
            return (
              <div key={w.workId} className="ck-split" style={{ position: 'absolute', inset: 0, display: wActive ? 'flex' : 'none' }}>
                <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                  <TerminalPane sid={w.sid} cwd={w.cwd} cmd="worker" active={wActive} />
                </div>
                {panelOpen ? <SpacePanel cwd={w.cwd} repoId={w.repo} active={wActive} /> : null}
              </div>
            )
          })}
        </div>
      </AppShell.Main>
    </AppShell>
    <Settings
      opened={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      configNonce={configNonce}
      onPromptTab={(tabId) => { addTab(SCRATCH, 'claude', { id: tabId, kind: 'claude' }); setActiveSpaceId(SCRATCH); setSettingsOpen(false) }}
    />
    <Picker
      opened={picker.open}
      onClose={() => setPicker((p) => ({ ...p, open: false }))}
      placeholder={picker.mode === 'switch' ? 'Jump to a space, worker or repo…' : 'Open a space in… (type to filter repos)'}
      items={pickerItems()}
    />
    {openFolder && (
      <OpenFolderModal onClose={() => setOpenFolder(false)} onOpen={(cwd, label, kind) => { openSpace(null, cwd, label, kind); setOpenFolder(false) }} />
    )}
    {openRepo && (
      <OpenSpaceModal
        repo={openRepo}
        onClose={() => setOpenRepo(null)}
        onOpen={(cwd, label) => { openSpace(openRepo, cwd, label); setOpenRepo(null) }}
      />
    )}
    <Modal opened={!!closingWorker} onClose={() => { if (!deleting) { setClosingWorker(null); setCloseErr(null) } }} title={closingWorker && sessions[closingWorker.sid] === 'exited' ? 'Worker finished' : 'Close dispatched worker'} centered>
      {closingWorker && (
        <Stack gap="sm">
          {sessions[closingWorker.sid] === 'exited' && (
            <Text size="sm" c="dimmed">
              <b>{closingWorker.agent} · {closingWorker.ticket || closingWorker.branch}</b> has ended.
            </Text>
          )}
          <Text size="sm">Close <b>{closingWorker.agent} · {closingWorker.ticket || closingWorker.branch}</b>? Removing the worktree leaves any pushed branch/PR intact.</Text>
          <Text size="xs" c="dimmed" ff="monospace" style={{ wordBreak: 'break-all' }}>{closingWorker.cwd}</Text>
          {closingWorker.pr && <Text size="xs">PR: {isHttpUrl(closingWorker.pr) ? <a href={closingWorker.pr} target="_blank" rel="noreferrer">{closingWorker.pr}</a> : closingWorker.pr}</Text>}
          {closingWorker.summary && (
            <ScrollArea.Autosize mah={160} type="auto">
              <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>{closingWorker.summary}</Text>
            </ScrollArea.Autosize>
          )}
          {closeErr && <Text size="xs" c="red">{closeErr}</Text>}
          <Group justify="flex-end" gap="xs" mt="xs">
            <Button variant="default" size="xs" disabled={deleting} onClick={() => { setClosingWorker(null); setCloseErr(null) }}>Cancel</Button>
            <Button variant="subtle" color="gray" size="xs" disabled={deleting} onClick={() => confirmCloseWorker(false, false)}>Close, keep worktree</Button>
            {closeErr && /uncommitted|refus/i.test(closeErr)
              ? <Button color="red" size="xs" loading={deleting} onClick={() => confirmCloseWorker(true, true)}>Force delete (discard changes)</Button>
              : <Button color="red" size="xs" loading={deleting} onClick={() => confirmCloseWorker(true, false)}>Close &amp; delete worktree</Button>}
          </Group>
        </Stack>
      )}
    </Modal>
    </>
  )
}

// A header eye icon for the watched repos; the tooltip lists each repo and
// its branch/dirty state.
function WatchingIndicator({ repos }: { repos: RepoCfg[] }) {
  const [git, setGit] = useState<Record<string, GitInfo>>({})
  const [failed, setFailed] = useState<Record<string, boolean>>({})
  const key = repos.map((r) => r.id).join('|')
  useEffect(() => {
    if (!repos.length) return
    let cancelled = false
    let inFlight = false
    const poll = async () => {
      if (inFlight) return
      inFlight = true
      const settled = await Promise.allSettled(repos.map((r) => getGit(r.path)))
      if (!cancelled) {
        setGit((prev) => { const next = { ...prev }; repos.forEach((r, i) => { const s = settled[i]; if (s.status === 'fulfilled') next[r.id] = s.value }); return next })
        setFailed(Object.fromEntries(repos.map((r, i) => [r.id, settled[i].status === 'rejected'])))
      }
      inFlight = false
    }
    poll()
    const iv = window.setInterval(poll, 8000)
    return () => { cancelled = true; clearInterval(iv) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  if (!repos.length) return null
  const label = (
    <Stack gap={4} py={2}>
      <Text size="xs" fw={700} tt="uppercase" c="dimmed" style={{ letterSpacing: '.08em' }}>Watching {repos.length}</Text>
      {repos.map((r) => {
        const g = git[r.id]
        return (
          <Group key={r.id} gap={8} wrap="nowrap" justify="space-between">
            <Text size="xs">{r.slug}</Text>
            <Text size="xs" ff="monospace" c={failed[r.id] ? 'red' : 'dimmed'}>
              {failed[r.id] ? 'unreachable' : g ? (g.branch ?? 'no git') : '…'}{g?.changed ? ` ·±${g.changed}` : ''}{g?.ahead ? ` ·↑${g.ahead}` : ''}
            </Text>
          </Group>
        )
      })}
    </Stack>
  )
  return (
    <Tooltip label={label} openDelay={200} withArrow multiline position="bottom-end" color="dark">
      <ActionIcon variant="subtle" color="gray" component="span" aria-label={`Watching ${repos.length} repos`} style={{ cursor: 'default' }}>
        <IconEye size={17} />
      </ActionIcon>
    </Tooltip>
  )
}

// Bottom-left connected pill: a live dot + compact claude-count / server-memory,
// with the full breakdown (memory, sessions by kind, uptime) in the tooltip.
function ConnectedStatus() {
  const [h, setH] = useState<Health | null>(null)
  const [ok, setOk] = useState(true)
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try { const r = await getHealth(); if (!cancelled) { setH(r); setOk(true) } }
      catch { if (!cancelled) setOk(false) }
    }
    poll()
    const iv = window.setInterval(poll, 5000)
    return () => { cancelled = true; clearInterval(iv) }
  }, [])
  const fmtMem = (n: number) => n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : `${Math.round(n / 1048576)} MB`
  const upt = (s: number) => s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  const KV = ({ k, v }: { k: string; v: string }) => (
    <Group gap={16} justify="space-between" wrap="nowrap"><Text size="xs" c="dimmed">{k}</Text><Text size="xs" className="ck-num">{v}</Text></Group>
  )
  const footprint = h?.treeMem ?? h?.serverRss ?? null
  const label = (
    <Stack gap={4} py={2} miw={210}>
      <Text size="xs" fw={700} tt="uppercase" c="dimmed" style={{ letterSpacing: '.08em' }}>Cockpit</Text>
      {h ? (
        <>
          <KV k={h.treeMem != null ? 'Memory (all agents)' : 'Memory (server only)'} v={footprint != null ? fmtMem(footprint) : 'unavailable'} />
          <KV k="Server process" v={fmtMem(h.serverRss)} />
          <KV k="System memory" v={`${fmtMem(h.sysTotal - h.sysFree)} / ${fmtMem(h.sysTotal)} used`} />
          <KV k="Claude sessions" v={String(h.sessions.claudes)} />
          <KV k="Codex sessions" v={String(h.sessions.codex)} />
          <KV k="Shells" v={String(h.sessions.shell)} />
          <KV k="Uptime" v={upt(h.uptime)} />
        </>
      ) : <Text size="xs" c="dimmed">{ok ? 'loading…' : 'server unreachable'}</Text>}
    </Stack>
  )
  return (
    <Tooltip label={label} withArrow position="top-start" multiline color="dark" openDelay={120}>
      <Group gap={8} px="md" py={8} wrap="nowrap" style={{ borderTop: '1px solid var(--ck-border)', cursor: 'default' }}>
        <Box w={8} h={8} style={{ borderRadius: '50%', background: ok ? 'var(--mantine-color-teal-5)' : 'var(--mantine-color-red-5)', flex: 'none' }} />
        <Text size="xs" c="dimmed">{ok ? 'Connected' : 'Disconnected'}</Text>
        {h ? <Text size="xs" c="dimmed" className="ck-num" ml="auto">{h.sessions.claudes}c{footprint != null ? ` · ${fmtMem(footprint)}` : ''}</Text> : null}
      </Group>
    </Tooltip>
  )
}

// Orchestrator context + Restart, combined into one control: the ctx badge lights
// (red) at/above the rotate threshold; clicking it opens usage detail and Restart.
const ORCH_DOT: Record<string, string> = {
  working: 'var(--ck-yellow)',
  awaiting: 'var(--mantine-color-red-5)',
  idle: 'var(--mantine-color-teal-5)',
  exited: 'var(--mantine-color-gray-6)'
}
// Stalled is the server's own call (ctx.stalled — missing means not); the age
// (since the last tick, or before the first, since the server started) is only for
// display, re-read every 30 s. A stall raises one browser notification when they're
// allowed, and a reload doesn't raise it again (the notified stall is kept in
// sessionStorage).
function useStall(ctx: OrchContext | null) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 30e3); return () => clearInterval(t) }, [])
  const ticked = ctx?.lastTickAt || 0
  const since = ticked || ctx?.startedAt || 0
  const age = since ? now - since : null
  const stalled = ctx?.stalled === true
  const told = useRef(0)
  useEffect(() => {
    if (!stalled || told.current === since) return
    told.current = since
    try { if (sessionStorage.getItem(STALL_KEY) === String(since)) return; sessionStorage.setItem(STALL_KEY, String(since)) } catch {}
    try { if (Notification.permission === 'granted') new Notification('Jeeves has stopped ticking', { body: `No tick for ${Math.round((age ?? 0) / 60e3)} min — check the orchestrator pane.` }) } catch {}
  }, [stalled, since, age])
  return { age, ticked, stalled }
}
// One usage bar: label and percent over a bar coloured by how close it is to the limit,
// with the time until it resets.
function UsageBar({ label, pct, resetsAt }: { label: string; pct: number | null; resetsAt?: number | null }) {
  const left = resetsAt ? resetsAt - Date.now() : null
  const until = left && left > 0 ? (left >= 864e5 ? `${Math.floor(left / 864e5)}d ${Math.floor((left % 864e5) / 36e5)}h` : `${Math.floor(left / 36e5)}h ${String(Math.floor((left % 36e5) / 6e4)).padStart(2, '0')}m`) : null
  const color = pct == null ? 'gray' : pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : 'teal'
  return (
    <Box>
      <Group justify="space-between" gap={6} mb={3}>
        <Text size="xs" fw={600}>{label}</Text>
        <Text size="xs" c="dimmed" className="ck-num">{pct == null ? '—' : `${Math.round(pct)}%`}{until ? ` · resets in ${until}` : ''}</Text>
      </Group>
      <Progress value={pct ?? 0} color={color} size="sm" radius="xl" />
    </Box>
  )
}

const ago = (ms: number) => (ms < 60e3 ? 'just now' : ms < 3600e3 ? `${Math.round(ms / 60e3)} min ago` : `${Math.round(ms / 3600e3)} h ago`)

function OrchControl({ ctx, onRestart }: { ctx: OrchContext | null; onRestart: () => void }) {
  const pct = ctx?.pct ?? null
  const rotateAt = ctx?.rotateAt ?? 70
  const { age, ticked, stalled } = useStall(ctx)
  const hot = (pct != null && pct >= rotateAt) || stalled
  const color = pct == null && !stalled ? 'gray' : hot ? 'red' : pct != null && pct >= rotateAt - 15 ? 'yellow' : 'teal'
  const st = ctx?.status
  const canNotify = typeof Notification !== 'undefined' && Notification.permission === 'default'
  return (
    <Menu shadow="md" width={280} position="bottom-end" withinPortal>
      <Menu.Target>
        <UnstyledButton aria-label="Orchestrator context and restart">
          <Badge variant={hot ? 'filled' : 'light'} color={color} size="sm" className="ck-num"
            style={{ cursor: 'pointer', minWidth: 62 }}
            leftSection={<Box w={7} h={7} style={{ borderRadius: '50%', background: st ? (ORCH_DOT[st] || 'var(--mantine-color-gray-6)') : 'transparent' }} />}>
            {stalled ? 'stalled' : `ctx ${pct == null ? '—' : pct + '%'}`}
          </Badge>
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Orchestrator</Menu.Label>
        <Box px="sm" pb={6}>
          <Text size="xs" c="dimmed">Status: {st ?? 'unknown'}</Text>
          <Text size="xs" c={stalled ? 'red' : 'dimmed'}>
            Last tick: {ticked && age != null ? ago(age) : 'not yet'}{stalled ? ` — expected every ${Math.round((ctx?.tickEveryMs ?? 300e3) / 60e3)} min` : ''}
          </Text>
          <Text size="xs" c="dimmed">
            {ctx?.pct == null ? 'context — waiting for the session'
              : `${ctx.used.toLocaleString()} / ${ctx.window.toLocaleString()} tokens · rotate at ${rotateAt}%`}
          </Text>
        </Box>
        <Menu.Divider />
        <Menu.Label>Usage</Menu.Label>
        <Stack gap={10} px="sm" pb={8}>
          <UsageBar label="Context" pct={pct} />
          <UsageBar label="5-hour limit" pct={ctx?.usage?.fiveHour?.used ?? null} resetsAt={ctx?.usage?.fiveHour?.resetsAt} />
          <UsageBar label="Weekly limit" pct={ctx?.usage?.sevenDay?.used ?? null} resetsAt={ctx?.usage?.sevenDay?.resetsAt} />
          {!ctx?.usage ? <Text size="xs" c="dimmed">Limits appear once a Claude session started here reports them (its status line refreshes every 30 s).</Text> : null}
        </Stack>
        <Menu.Divider />
        {canNotify ? <Menu.Item onClick={() => { Notification.requestPermission().catch(() => {}) }}>Notify me if the loop stalls</Menu.Item> : null}
        <Menu.Item leftSection={<IconRefresh size={14} />} color={hot ? 'red' : undefined} onClick={onRestart}>
          Restart orchestrator
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  )
}
