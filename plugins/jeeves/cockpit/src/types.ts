export type RepoCfg = {
  id: string; slug: string; path: string
  jiraKey?: string | null; jiraBase?: string | null
  // Effective values: project.md overlaid on defaults.md (edited in Settings).
  baseBranch?: string | null
  reviewCommand?: string | null
  seedFiles?: string[]          // files copied into each new worktree
}

// ── Settings: config files with provenance (GET/POST /api/settings/config) ──
// A project field's effective value: set in its project.md, inherited from
// defaults.md, or unset in both. `default` is what it inherits.
export type Source = 'project' | 'default' | 'unset'
export type Eff<T> = { value: T | null; source: Source; default?: T | null }
export type ProjectFields = {
  baseBranch: Eff<string>; jiraKey: Eff<string>; reviewScope: Eff<string>
  reviewCommand: Eff<string>; seedFiles: Eff<string[]>
}
export type ProjectView = {
  id: string; slug: string
  repo: Eff<string>; path: Eff<string>
  fields: ProjectFields
  otherOverrides: string[] // defaults.md labels this project.md replaces that the form doesn't edit
}
export type DefaultsValues = {
  cloudId: string | null; jiraSite: string | null; planTrigger: string | null; qaAssigneeField: string | null
  qaColumns: string[] | null; confluenceSpace: string | null; plansParent: string | null
  reviewScope: string | null; baseBranches: string[] | null; reviewCommand: string | null; seedFiles: string[] | null
  // Loop behaviour (read by the loop at launch)
  tickSeconds: string | null; tickMidFlightSeconds: string | null; tickOvernightSeconds: string | null
  overnight: string | null; dailySummary: string | null; dailySummaryAt: string | null
  pushNotifications: string | null; notifyReminders: string | null; notifyWorkerFinished: string | null; notifyReviewReady: string | null
}
export type IdentityValues = { ghLogin: string | null; jiraEmail: string | null; displayName: string | null; devRoot: string | null }
export type ConfigView = {
  home: string
  defaults: { exists: boolean; values: DefaultsValues }
  identity: { exists: boolean; values: IdentityValues }
  projects: ProjectView[]
}
// ── Settings: cockpit.json + the cockpit's address (GET/POST /api/settings) ──
export type CockpitKey = 'orchModel' | 'orchEffort' | 'workerModel' | 'orchPermission' | 'workerPermission' | 'rotatePct' | 'compactPct' | 'detachMinutes' | 'claudeTui' | 'scrollSpeed'
  | 'uiFont' | 'monoFont' | 'terminalFontSize'
export type CockpitView = {
  values: Record<CockpitKey, string | number>
  defaults: Record<CockpitKey, string | number>
  pinned: Partial<Record<CockpitKey, string>> // key → the env var that pins it
  choices: { models: string[]; efforts: string[]; permissionModes: string[] }
}
export type SettingsView = {
  loopConstraints: string
  baseline: string          // the plugin's shipped loop-constraints.md
  home: string; host: string; port: number
  url: string               // cockpit URL with the token
  tokenPinned: boolean      // $JEEVES_TOKEN is set, so the token can't rotate
  cockpit: CockpitView
}
export type SettingsWrite = { loopConstraints: string } | { cockpit: { set: Record<string, string | string[]>; unset: string[] } } | { rotateToken: true }
export type Reminder = { id: string; due: string; what: string; set: string | null } // due: local YYYY-MM-DD HH:MM
export type ReminderOp = { op: 'add'; what: string; due: string } | { op: 'done' | 'delete'; id: string } | { op: 'snooze'; id: string; by: '1h' | '1d' }

// ── Settings: agents (GET/POST /api/agents) ──
// The plugin's agents/ files and the user's <data-home>/agents/ ones. A user file named
// like a built-in overrides it; `base` is the built-in's hash when it was customised.
export type AgentDef = { name: string; description: string; tools: string[]; model: string; prompt: string }
export type UserAgent = AgentDef & { base: string | null }
export type BuiltinAgent = AgentDef & { hash: string; override: (UserAgent & { stale: boolean }) | null }
export type AgentsView = { builtin: BuiltinAgent[]; custom: UserAgent[]; choices: { tools: string[]; models: string[] } }
export type AgentOp = { op: 'save'; agent: AgentDef; isNew?: boolean } | { op: 'delete'; name: string }

export type ConfigWrite ={ file: 'defaults' | 'identity' | 'project'; project?: string; set: Record<string, string | string[]>; unset: string[] }

export type TabKind = 'shell' | 'claude' | 'codex'
// Worker terminals attach to a pre-spawned session; 'orch' boots the orchestrator.
export type PtyCmd = TabKind | 'orch' | 'worker'
export type Tab = { id: string; kind: TabKind; title?: string } // title: user-renamed label (double-click a tab)

export type Space = {
  id: string
  repoId: string
  name: string
  cwd: string
  tabs: Tab[]
  activeTabId: string
  borrowed?: boolean // opened on a dispatched worker's worktree — closing never deletes it
  openId?: string    // spaceRef from the orchestrator's open_space, so add_tab/close_space can target it
}

// The user's layout, shared by every browser through the server (/api/layout).
export type Layout = { spaces: Space[]; scratch: Space; pinned: string[]; recent: string[] }

// upstream is the tracked remote ref, e.g. origin/fix/x — or origin/qa for a branch cut from qa and never pushed.
export type GitInfo = { git: boolean; branch: string | null; upstream?: string | null; changed: number; ahead: number; behind: number }

// Space git panel.
// add/del: lines added and removed (absent for untracked and binary files).
export type ChangedFile = { path: string; from?: string; xy: string; kind: 'added' | 'modified' | 'deleted' | 'renamed'; staged: boolean; add?: number; del?: number }
export type Changes = { git: boolean; branch?: string | null; ahead?: number; behind?: number; files: ChangedFile[] }
export type FileDiff = { path: string; old?: string; new?: string; binary?: boolean; error?: string }
export type PrStatus = { branch?: string; defaultBase?: string; pr?: { number: number; title?: string; url: string; state: string; isDraft?: boolean; reviewDecision?: string | null; base?: string | null } | null; checks?: Checks | null; error?: string }

export type Worktree = { path: string; branch: string | null; isMain: boolean }

export type Health = {
  ok: boolean
  uptime: number
  serverRss: number       // the Node server process alone
  treeMem: number | null  // server + all spawned agents (PTYs + children), footprint on macOS; null if the probe failed
  sysTotal: number
  sysFree: number         // free system memory
  sessions: { orch: number; worker: number; claude: number; codex: number; shell: number; claudes: number; total: number }
}

export type Branches = { local: string[]; remote: string[] }

export type PR = { number: number; title: string; branch: string; author: string }

export type PrView = {
  number?: number; title?: string; body?: string; url?: string; state?: string; isDraft?: boolean; reviewDecision?: string | null
  author?: string; additions?: number; deletions?: number; changedFiles?: number; head?: string | null; base?: string | null; checks?: Checks | null
  checkRuns?: { name: string; state: Checks; url?: string | null }[]
  reviews?: { author: string; state: string }[]
  error?: string
}

// ── Control plane ────────────────────────────────────────────────────────────
export type Dot = 'red' | 'yellow' | 'green' | 'white'
export type Checks = 'pass' | 'fail' | 'pending'
export type StoryPhase = 'needs-plan' | 'planning' | 'awaiting-approval' | 'approved' | 'in-progress' | 'in-review' | 'blocked' | 'done'

// A one-click launcher chip on a row. run = the exact composer reply; type=true
// types it without submitting (for a reply the user must complete first).
export type SurfaceAction = { label: string; run?: string; type?: boolean; href?: string; onPick?: () => void } // onPick: a UI-side action, no command sent

export type Story = { item: string; key?: string; status?: string; phase?: StoryPhase; dot?: Dot; repo?: string; next?: string; actions?: SurfaceAction[] }
export type MyPr = { item: string; number?: string | number; checks?: Checks; state?: string; dot?: Dot; repo?: string; next?: string; actions?: SurfaceAction[] }
export type QaRow = { item: string; key?: string; priority?: string; status?: string; dot?: Dot; repo?: string; next?: string; actions?: SurfaceAction[] }
export type ReviewRow = { item: string; number?: string | number; author?: string; checks?: Checks; state?: string; dot?: Dot; repo?: string; next?: string; actions?: SurfaceAction[] }

export type Surface = {
  quiet?: string
  stories?: Story[]
  myPrs?: MyPr[]
  qa?: QaRow[]
  reviews?: ReviewRow[]
  inFlight?: { text: string; repo?: string }[]
  updatedAt?: number
} | null

export type WorkerStatus = 'working' | 'awaiting' | 'idle' | 'blocked' | 'done' | 'error' | 'exited'

export type WorkerSpace = {
  workId: string
  sid: string
  agent: string
  repo: string
  repoSlug: string
  ticket: string | null
  branch: string
  cwd: string
  status: WorkerStatus
  summary: string | null
  pr: string | null
  createdAt: number
  updatedAt: number
}

// Command from the orchestrator (open_space tool) telling the UI to open a space.
export type OpenSpaceCmd = { id: string; repoId: string; cwd: string; label: string; kind: TabKind; tab?: Tab } // tab: its id is fixed so a pending command finds it
// add_tab / close_space, targeting a space by the spaceRef open_space returned, or
// (open_tab from a claude tab) by the space's own id. `tab` fixes the new tab's id,
// which the server's pending launch is keyed by; `open` opens the space (borrowed,
// in the background) when no space has that spaceRef — a worker's child tabs.
// close_tab removes the tab `tabId` from whichever space holds it.
export type SpaceCmd = {
  id: string
  t: 'add_tab' | 'close_space' | 'close_tab'
  spaceRef?: string
  spaceId?: string
  tabId?: string
  kind?: TabKind
  tab?: Tab
  open?: { repoId: string; cwd: string; label: string }
}

export type OrchContext = {
  pct: number | null
  used: number
  window: number
  model: string | null
  sessionId: string
  rotateAt: number
  status?: string // hook-driven: working | awaiting | idle | exited
  updatedAt: number
  lastTickAt?: number  // when the loop last ticked (0 = not since the server started)
  startedAt?: number   // when the server started (ms)
  tickEveryMs?: number // the gap it should keep right now (normal, mid-flight or overnight)
  stalled?: boolean    // the server's own call — missing means not stalled
  // The account's rate limits, as a launched session's status line last reported them.
  usage?: { fiveHour: RateLimit | null; sevenDay: RateLimit | null; at: number } | null
}
export type RateLimit = { used: number; resetsAt: number | null } // used: percent; resetsAt: epoch ms

// ── Pure layout/view decisions ──────────────────────────────────────────────
// Kept free of any DOM-touching import (this module has none) so they run under
// plain node:test via test/layout.cases.ts, same as ptyLink.ts and keys.ts.

// A `work:<id>` view is stale once the first `spaces` message has told us which
// workers are actually dispatched and this one isn't among them (closed elsewhere,
// or from a browser reload after it ended). Before that first message, a guess
// would be wrong more often than not, so the view is left alone. Everything else —
// ORCH, SCRATCH, a browser's own space — is left alone regardless; this only knows
// about worker views.
export function resolveActiveSpaceId(activeSpaceId: string, workers: WorkerSpace[], workersLoaded: boolean, fallback: string): string {
  if (!activeSpaceId.startsWith('work:')) return activeSpaceId
  if (!workersLoaded) return activeSpaceId
  const workId = activeSpaceId.slice('work:'.length)
  return workers.some((w) => w.workId === workId) ? activeSpaceId : fallback
}

// A browser's first sync folds in the spaces it only knows about (opened locally
// before the server's layout ever arrived) alongside the server's canonical list;
// every later sync just takes the server's layout outright, so this only runs once.
export function mergeLocalSpaces(localSpaces: Space[], serverSpaces: Space[]): Space[] {
  return localSpaces.filter((s) => !serverSpaces.some((x) => x.id === s.id))
}

// Which tab is active in a space is a per-browser choice (like activeSpaceId, never
// synced): once this browser has picked one, that choice wins over whatever another
// browser last saved for the same space. A space this browser has never chosen a
// tab in yet keeps the incoming value (e.g. a space another browser just opened).
export function applyOwnActiveTabs(spaces: Space[], own: Record<string, string>): Space[] {
  return spaces.map((s) => (own[s.id] ? { ...s, activeTabId: own[s.id] } : s))
}

// The wire layout never carries per-browser tab selection: comparing (and marking
// "already synced") a copy with every activeTabId blanked out means switching tabs
// alone never looks like a change worth saving, and never triggers a save.
export function stripActiveTabs(spaces: Space[]): Space[] {
  return spaces.map((s) => ({ ...s, activeTabId: '' }))
}
