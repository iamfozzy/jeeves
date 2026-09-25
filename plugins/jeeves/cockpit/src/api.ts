import type { AgentOp, AgentsView, Branches, Changes, ConfigView, ConfigWrite, FileDiff, GitInfo, Health, Layout, PR, PrStatus, PrView, Reminder, ReminderOp, RepoCfg, SettingsView, SettingsWrite, Worktree } from './types'
import { authHeaders } from './token'
import type { Appearance } from './theme'

// Whether a URL from the server (an agent's action link, a worker's PR) is safe to
// render as a link: only http(s), never javascript: or data:.
export const isHttpUrl = (u: string) => /^https?:\/\//i.test(u)

// A 401 means this token is dead (rotated elsewhere, or the URL is stale) — every
// request past it will fail the same way, so the app shows one fixed message
// instead of a UI that's broken in a dozen different spots.
type UnauthListener = () => void
let unauthorized = false
const unauthListeners = new Set<UnauthListener>()
function markUnauthorized() {
  if (unauthorized) return
  unauthorized = true
  unauthListeners.forEach((fn) => fn())
}
export function onUnauthorized(fn: UnauthListener): () => void {
  unauthListeners.add(fn)
  return () => unauthListeners.delete(fn)
}
export function isUnauthorized(): boolean { return unauthorized }

async function checked(r: Response): Promise<Response> {
  if (r.status === 401) markUnauthorized()
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
  return r
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: authHeaders() })
  return (await checked(r)).json()
}

// A JSON POST/PUT/DELETE: throws on a non-2xx status (a genuine failure to reach
// the handler — an expected "can't do that" answer is still `{ error }` on a 200).
async function postJson<T>(url: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const { method = 'POST', body } = opts
  const r = await fetch(url, {
    method,
    headers: authHeaders(body !== undefined ? { 'content-type': 'application/json' } : undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  return (await checked(r)).json()
}

export function getConfig(): Promise<{ repos: RepoCfg[]; home: string; scratchRoot?: string; appearance?: Appearance }> {
  return getJson('/api/config')
}

export function getLayout(): Promise<{ layout: Layout | null }> {
  return getJson('/api/layout')
}
export async function saveLayout(layout: Layout, from: string): Promise<void> {
  await checked(await fetch('/api/layout', { method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ layout, from }) }))
}

// A folder space's directory: a typed path (~ expanded) resolved and checked by the server.
// The user's Claude Code status line, and installing the cockpit's.
export type StatusLineView = { current: string | null; installed: boolean; needsConfirm?: boolean; error?: string }
export function getStatusLine(): Promise<StatusLineView> { return getJson('/api/statusline') }
export function installStatusLine(replace = false): Promise<StatusLineView> {
  return postJson('/api/statusline', { body: { replace } })
}

// The orchestrator guard's refusals, newest first.
export type GuardRow = { at: string; tool: string; what: string; why: string; allowed?: boolean } // allowed: a command run for the user, logged not refused
export function getGuardLog(): Promise<{ rows: GuardRow[] }> {
  return getJson('/api/guard-log')
}

export type FolderView = { path?: string; name?: string; error?: string; parent?: string | null; dirs?: string[] }
export function resolveFolder(path: string, list = false): Promise<FolderView> {
  return getJson('/api/folder?path=' + encodeURIComponent(path) + (list ? '&list=1' : ''))
}

export function getGit(cwd: string): Promise<GitInfo> {
  return getJson('/api/git?cwd=' + encodeURIComponent(cwd))
}

export function getHealth(): Promise<Health> {
  return getJson('/api/health')
}

// Space git panel: changed files, one file's HEAD-vs-worktree diff, PR/checks state.
export function getChanges(cwd: string, base?: string): Promise<Changes> {
  return getJson('/api/changes?cwd=' + encodeURIComponent(cwd) + (base ? '&base=' + encodeURIComponent(base) : ''))
}
export function getFileDiff(cwd: string, path: string, base?: string): Promise<FileDiff> {
  return getJson('/api/filediff?cwd=' + encodeURIComponent(cwd) + '&path=' + encodeURIComponent(path) + (base ? '&base=' + encodeURIComponent(base) : ''))
}
// Discard one file's uncommitted changes (back to HEAD; an untracked file is deleted).
export function revertFile(cwd: string, path: string): Promise<{ ok?: boolean; error?: string }> {
  return postJson('/api/revert', { body: { cwd, path } })
}
export function getPrStatus(cwd: string): Promise<PrStatus> {
  return getJson('/api/prstatus?cwd=' + encodeURIComponent(cwd))
}

// Drop a file into a space — written to <cwd>/.jeeves-uploads/. Returns the path
// relative to cwd, which the caller drops into the session's input.
export async function uploadFile(cwd: string, file: File): Promise<{ ok?: boolean; path?: string; error?: string }> {
  const qs = `cwd=${encodeURIComponent(cwd)}&name=${encodeURIComponent(file.name)}`
  const r = await fetch('/api/upload?' + qs, { method: 'POST', headers: authHeaders(), body: file })
  return (await checked(r)).json()
}

// Reveal a space's folder in VS Code ('editor') or the OS file manager ('files').
export function openFolder(cwd: string, target: 'editor' | 'files'): Promise<{ ok?: boolean; error?: string }> {
  return postJson('/api/open', { body: { cwd, target } })
}

export function killSession(sid: string): void {
  fetch('/api/session?sid=' + encodeURIComponent(sid), { method: 'DELETE', headers: authHeaders() }).then(checked).catch(() => {})
}

export function listWorktrees(repoId: string): Promise<{ worktrees: Worktree[] }> {
  return getJson('/api/worktrees?repoId=' + encodeURIComponent(repoId))
}

export function listBranches(repoId: string): Promise<Branches> {
  return getJson('/api/branches?repoId=' + encodeURIComponent(repoId))
}

export function listPRs(repoId: string): Promise<{ prs?: PR[]; error?: string }> {
  return getJson('/api/prs?repoId=' + encodeURIComponent(repoId))
}

export function getPrView(repoId: string, number: string | number): Promise<PrView> {
  return getJson('/api/prview?repoId=' + encodeURIComponent(repoId) + '&number=' + encodeURIComponent(String(number)))
}

export function createWorktree(repoId: string, branch: string): Promise<{ path?: string; branch?: string; error?: string }> {
  return postJson('/api/worktree', { body: { repoId, branch } })
}

export function deleteWorktree(repoId: string, path: string, force = false): Promise<{ ok?: boolean; error?: string }> {
  const qs = `repoId=${encodeURIComponent(repoId)}&path=${encodeURIComponent(path)}${force ? '&force=1' : ''}`
  return postJson('/api/worktree?' + qs, { method: 'DELETE' })
}

export function closeWork(workId: string, removeWorktree = false, force = false): Promise<{ ok?: boolean; error?: string }> {
  const qs = `workId=${encodeURIComponent(workId)}${removeWorktree ? '&worktree=1' : ''}${force ? '&force=1' : ''}`
  return postJson('/api/work?' + qs, { method: 'DELETE' })
}

export function restartOrchestrator(): Promise<{ ok?: boolean; error?: string }> {
  return postJson('/api/orch/restart')
}

// loop-constraints.md, the shipped baseline, cockpit.json and the cockpit's address.
export function getSettings(): Promise<SettingsView> {
  return getJson('/api/settings')
}

// One settings write; answers with the fresh view (plus `token` after a rotation).
export function saveSettings(w: SettingsWrite): Promise<(SettingsView & { token?: string }) | { error: string }> {
  return postJson('/api/settings', { body: w })
}

// <data-home>/reminders.md rows; an edit answers with the fresh list (or an error).
export function getReminders(): Promise<{ reminders: Reminder[] }> {
  return getJson('/api/reminders')
}
export function editReminder(op: ReminderOp): Promise<{ reminders: Reminder[] } | { error: string }> {
  return postJson('/api/reminders', { body: op })
}

// Built-in and user agents; an edit answers with the fresh view (or an error).
export function getAgents(): Promise<AgentsView> {
  return getJson('/api/agents')
}
export function editAgent(op: AgentOp): Promise<AgentsView | { error: string }> {
  return postJson('/api/agents', { body: op })
}

// defaults.md, identity.md and every project's effective config.
export function getConfigView(): Promise<ConfigView> {
  return getJson('/api/settings/config')
}

// Edit one config file in place; answers with the fresh view (or an error).
export function saveConfig(w: ConfigWrite): Promise<ConfigView | { error: string }> {
  return postJson('/api/settings/config', { body: w })
}

// Register a claude tab the UI is about to add under `tabId`, started on `prompt`:
// the tab's first spawn takes it.
export function openPromptTab(tabId: string, prompt: string): Promise<{ ok?: boolean; error?: string }> {
  return postJson('/api/tab-prompt', { body: { tabId, prompt } })
}

// Type text into the orchestrator's terminal (its composer). submit=true also
// presses Enter, so a dashboard launcher chip runs with one click.
export function sendOrchInput(text: string, submit = false): Promise<{ ok?: boolean; error?: string }> {
  return postJson('/api/orch/input', { body: { text, submit } })
}
