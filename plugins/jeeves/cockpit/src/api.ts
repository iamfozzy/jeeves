import type { AgentOp, AgentsView, Branches, Changes, ConfigView, ConfigWrite, FileDiff, GitInfo, Health, Layout, PR, PrStatus, PrView, Reminder, ReminderOp, RepoCfg, SettingsView, SettingsWrite, Worktree } from './types'
import { authHeaders } from './token'
import type { Appearance } from './theme'

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: authHeaders() })
  return r.json()
}

export function getConfig(): Promise<{ repos: RepoCfg[]; home: string; scratchRoot?: string; appearance?: Appearance }> {
  return getJson('/api/config')
}

export function getLayout(): Promise<{ layout: Layout | null }> {
  return getJson('/api/layout')
}
export async function saveLayout(layout: Layout, from: string): Promise<void> {
  await fetch('/api/layout', { method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ layout, from }) })
}

// A folder space's directory: a typed path (~ expanded) resolved and checked by the server.
// The orchestrator guard's refusals, newest first.
export type GuardRow = { at: string; tool: string; what: string; why: string }
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
export async function revertFile(cwd: string, path: string): Promise<{ ok?: boolean; error?: string }> {
  const r = await fetch('/api/revert', {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ cwd, path })
  })
  return r.json()
}
export function getPrStatus(cwd: string): Promise<PrStatus> {
  return getJson('/api/prstatus?cwd=' + encodeURIComponent(cwd))
}

// Drop a file into a space — written to <cwd>/.jeeves-uploads/. Returns the path
// relative to cwd, which the caller drops into the session's input.
export async function uploadFile(cwd: string, file: File): Promise<{ ok?: boolean; path?: string; error?: string }> {
  const qs = `cwd=${encodeURIComponent(cwd)}&name=${encodeURIComponent(file.name)}`
  const r = await fetch('/api/upload?' + qs, { method: 'POST', headers: authHeaders(), body: file })
  return r.json()
}

// Reveal a space's folder in VS Code ('editor') or the OS file manager ('files').
export async function openFolder(cwd: string, target: 'editor' | 'files'): Promise<{ ok?: boolean; error?: string }> {
  const r = await fetch('/api/open', {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ cwd, target })
  })
  return r.json()
}

export function killSession(sid: string): void {
  fetch('/api/session?sid=' + encodeURIComponent(sid), { method: 'DELETE', headers: authHeaders() }).catch(() => {})
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

export async function createWorktree(repoId: string, branch: string): Promise<{ path?: string; branch?: string; error?: string }> {
  const r = await fetch('/api/worktree', {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ repoId, branch })
  })
  return r.json()
}

export async function deleteWorktree(repoId: string, path: string, force = false): Promise<{ ok?: boolean; error?: string }> {
  const qs = `repoId=${encodeURIComponent(repoId)}&path=${encodeURIComponent(path)}${force ? '&force=1' : ''}`
  const r = await fetch('/api/worktree?' + qs, { method: 'DELETE', headers: authHeaders() })
  return r.json()
}

export async function closeWork(workId: string, removeWorktree = false, force = false): Promise<{ ok?: boolean; error?: string }> {
  const qs = `workId=${encodeURIComponent(workId)}${removeWorktree ? '&worktree=1' : ''}${force ? '&force=1' : ''}`
  const r = await fetch('/api/work?' + qs, { method: 'DELETE', headers: authHeaders() })
  return r.json()
}

export async function restartOrchestrator(): Promise<{ ok?: boolean; error?: string }> {
  const r = await fetch('/api/orch/restart', { method: 'POST', headers: authHeaders() })
  return r.json()
}

// loop-constraints.md, the shipped baseline, cockpit.json and the cockpit's address.
export function getSettings(): Promise<SettingsView> {
  return getJson('/api/settings')
}

// One settings write; answers with the fresh view (plus `token` after a rotation).
export async function saveSettings(w: SettingsWrite): Promise<(SettingsView & { token?: string }) | { error: string }> {
  const r = await fetch('/api/settings', {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(w)
  })
  return r.json()
}

// <data-home>/reminders.md rows; an edit answers with the fresh list (or an error).
export function getReminders(): Promise<{ reminders: Reminder[] }> {
  return getJson('/api/reminders')
}
export async function editReminder(op: ReminderOp): Promise<{ reminders: Reminder[] } | { error: string }> {
  const r = await fetch('/api/reminders', {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(op)
  })
  return r.json()
}

// Built-in and user agents; an edit answers with the fresh view (or an error).
export function getAgents(): Promise<AgentsView> {
  return getJson('/api/agents')
}
export async function editAgent(op: AgentOp): Promise<AgentsView | { error: string }> {
  const r = await fetch('/api/agents', {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(op)
  })
  return r.json()
}

// defaults.md, identity.md and every project's effective config + ledger.
export function getConfigView(): Promise<ConfigView> {
  return getJson('/api/settings/config')
}

// Edit one config file in place; answers with the fresh view (or an error).
export async function saveConfig(w: ConfigWrite): Promise<ConfigView | { error: string }> {
  const r = await fetch('/api/settings/config', {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(w)
  })
  return r.json()
}

// Type text into the orchestrator's terminal (its composer). submit=true also
// presses Enter, so a dashboard launcher chip runs with one click.
export async function sendOrchInput(text: string, submit = false): Promise<{ ok?: boolean; error?: string }> {
  const r = await fetch('/api/orch/input', {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ text, submit })
  })
  return r.json()
}
