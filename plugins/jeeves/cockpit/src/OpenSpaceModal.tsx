import { useEffect, useState, type ReactNode } from 'react'
import { Alert, Button, Divider, Group, Loader, Modal, SegmentedControl, Select, Stack, Tabs, Text, TextInput, UnstyledButton } from '@mantine/core'
import { createWorktree, listBranches, listPRs, listWorktrees, resolveFolder, type FolderView } from './api'
import type { Branches, PR, RepoCfg, TabKind, Worktree } from './types'

export function OpenSpaceModal({
  repo,
  onClose,
  onOpen
}: {
  repo: RepoCfg
  onClose: () => void
  onOpen: (cwd: string, label: string) => void
}) {
  const [tab, setTab] = useState<string | null>('branch')
  const [worktrees, setWorktrees] = useState<Worktree[] | null>(null)
  const [branches, setBranches] = useState<Branches | null>(null)
  const [prs, setPrs] = useState<{ prs?: PR[]; error?: string } | null>(null)

  const [branchSel, setBranchSel] = useState<string | null>(null)
  const [newBranch, setNewBranch] = useState('')
  const [prSearch, setPrSearch] = useState('')
  const [wtSearch, setWtSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listWorktrees(repo.id).then((r) => setWorktrees(r.worktrees ?? [])).catch(() => setWorktrees([]))
    listBranches(repo.id).then(setBranches).catch(() => setBranches({ local: [], remote: [] }))
  }, [repo.id])

  useEffect(() => {
    if (tab === 'pr' && prs === null) listPRs(repo.id).then(setPrs).catch(() => setPrs({ error: 'failed to run gh' }))
  }, [tab, prs, repo.id])

  async function createAndOpen(branch: string) {
    const b = branch.trim()
    if (!b || busy) return
    setBusy(true); setError(null)
    const res = await createWorktree(repo.id, b)
    setBusy(false)
    if (res.error || !res.path) { setError(res.error ?? 'failed') ; return }
    onOpen(res.path, res.branch ?? b)
  }

  const extra = (worktrees ?? []).filter((w) => !w.isMain)
  const prList = prs?.prs ?? []
  const prFiltered = prList.filter((p) => `${p.number} ${p.title} ${p.branch} ${p.author}`.toLowerCase().includes(prSearch.trim().toLowerCase()))
  const extraFiltered = extra.filter((w) => `${w.branch ?? ''} ${w.path}`.toLowerCase().includes(wtSearch.trim().toLowerCase()))
  const branchData = [
    { group: 'Local', items: branches?.local ?? [] },
    { group: 'Remote (origin)', items: branches?.remote ?? [] }
  ].filter((g) => g.items.length)

  return (
    <Modal opened onClose={onClose} centered size="lg" radius="md"
      styles={{ body: { overflowX: 'hidden' }, content: { overflowX: 'hidden' } }}
      title={<Text fw={600}>Open a space · <Text span c="dimmed" fw={500}>{repo.slug}</Text></Text>}>
      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="branch">Branch</Tabs.Tab>
          <Tabs.Tab value="pr">Pull request</Tabs.Tab>
          <Tabs.Tab value="worktree">Worktree{extra.length ? ` (${extra.length})` : ''}</Tabs.Tab>
        </Tabs.List>

        {/* Branch: check out an existing local/remote branch, or create a new one */}
        <Tabs.Panel value="branch">
          <Stack gap="lg">
            <Stack gap={6}>
              <Label>Existing branch</Label>
              <Group align="flex-end" gap="sm" wrap="nowrap">
                <Select
                  style={{ flex: 1 }}
                  data={branchData}
                  value={branchSel}
                  onChange={setBranchSel}
                  searchable
                  placeholder={branches ? 'search local or origin branches…' : 'loading…'}
                  nothingFoundMessage="no match"
                  leftSection={<BranchIcon />}
                  disabled={busy || !branches}
                  comboboxProps={{ withinPortal: true }}
                  maxDropdownHeight={260}
                />
                <Button onClick={() => branchSel && createAndOpen(branchSel)} loading={busy} disabled={!branchSel}>Check out</Button>
              </Group>
              <Text size="xs" c="dimmed">A remote-only branch is checked out into a new local tracking branch.</Text>
            </Stack>

            <Divider label="or" labelPosition="center" />

            <Stack gap={6}>
              <Label>New branch</Label>
              <Group align="flex-end" gap="sm" wrap="nowrap">
                <TextInput
                  style={{ flex: 1 }}
                  value={newBranch}
                  onChange={(e) => setNewBranch(e.currentTarget.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') createAndOpen(newBranch) }}
                  placeholder="feat/ABC-1234"
                  leftSection={<BranchIcon />}
                  disabled={busy}
                />
                <Button variant="light" onClick={() => createAndOpen(newBranch)} loading={busy} disabled={!newBranch.trim()}>Create</Button>
              </Group>
              <Text size="xs" c="dimmed">Branches off the current HEAD into a new worktree.</Text>
            </Stack>
          </Stack>
        </Tabs.Panel>

        {/* Pull request: check out a PR's branch */}
        <Tabs.Panel value="pr">
          {prs === null && <Group gap="xs"><Loader size="xs" /><Text size="sm" c="dimmed">loading pull requests…</Text></Group>}
          {prs?.error && <Alert color="red" variant="light" title="Couldn't list PRs">{prs.error} — is the GitHub CLI installed and authed?</Alert>}
          {prs?.prs && (
            <Stack gap="sm">
              <TextInput
                value={prSearch}
                onChange={(e) => setPrSearch(e.currentTarget.value)}
                placeholder="search by number, title, branch, author…"
                leftSection={<SearchIcon />}
                disabled={prList.length === 0}
              />
              <div style={{ maxHeight: 340, overflowY: 'auto', overflowX: 'hidden', width: '100%' }}>
                <Stack gap={6} style={{ minWidth: 0 }}>
                  {prList.length === 0 && <Text size="sm" c="dimmed">No open pull requests.</Text>}
                  {prList.length > 0 && prFiltered.length === 0 && <Text size="sm" c="dimmed">No PR matches “{prSearch}”.</Text>}
                  {prFiltered.map((pr) => (
                    <Row
                      key={pr.number}
                      icon={<Text span size="xs" c="dimmed" className="ck-num">#{pr.number}</Text>}
                      title={pr.title}
                      sub={`${pr.branch}  ·  @${pr.author}`}
                      onClick={() => createAndOpen(pr.branch)}
                    />
                  ))}
                </Stack>
              </div>
            </Stack>
          )}
        </Tabs.Panel>

        {/* Worktree: open an already-existing checkout */}
        <Tabs.Panel value="worktree">
          <Stack gap="sm">
            <Row icon={<FolderIcon />} title="main checkout" sub={repo.path} mono onClick={() => onOpen(repo.path, repo.id)} />
            {extra.length > 0 && (
              <TextInput
                value={wtSearch}
                onChange={(e) => setWtSearch(e.currentTarget.value)}
                placeholder="search worktrees by branch or path…"
                leftSection={<SearchIcon />}
              />
            )}
            <div style={{ maxHeight: 320, overflowY: 'auto', overflowX: 'hidden', width: '100%' }}>
              <Stack gap={6} style={{ minWidth: 0 }}>
                {worktrees === null && <Group gap="xs" pl={4}><Loader size="xs" /><Text size="xs" c="dimmed">loading…</Text></Group>}
                {worktrees && extra.length === 0 && <Text size="sm" c="dimmed">No other worktrees yet.</Text>}
                {extra.length > 0 && extraFiltered.length === 0 && <Text size="sm" c="dimmed">No worktree matches “{wtSearch}”.</Text>}
                {extraFiltered.map((w) => (
                  <Row key={w.path} icon={<BranchIcon />} title={w.branch ?? '(detached)'} sub={w.path} mono onClick={() => onOpen(w.path, w.branch ?? 'worktree')} />
                ))}
              </Stack>
            </div>
          </Stack>
        </Tabs.Panel>
      </Tabs>

      {error && <Alert mt="md" color="red" variant="light" title="Couldn't create worktree">{error}</Alert>}
    </Modal>
  )
}

function Label({ children }: { children: ReactNode }) {
  return <Text className="ck-label">{children}</Text>
}

// A folder space: any folder under the home dir, for work that isn't a configured repo.
// Browse by clicking through folders, or type a path (Enter jumps there); Open takes
// whatever the path box says.
export function OpenFolderModal({ onClose, onOpen }: { onClose: () => void; onOpen: (cwd: string, label: string, kind: TabKind) => void }) {
  const [home, setHome] = useState('')
  const [view, setView] = useState<FolderView | null>(null)
  const [path, setPath] = useState('~')
  const [name, setName] = useState('')
  const [kind, setKind] = useState<TabKind>('claude')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const tilde = (p: string) => (home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p)
  const go = async (to: string) => {
    const f = await resolveFolder(to, true).catch((): FolderView => ({ error: 'could not reach the cockpit' }))
    if (f.error || !f.path) { setError(f.error ?? 'not a folder'); return }
    setError(null); setView(f); setPath(tilde(f.path))
  }
  useEffect(() => {
    resolveFolder('~', true).then((f) => { if (f.path) { setHome(f.path); setView(f); setPath('~') } }).catch(() => setError('could not reach the cockpit'))
  }, [])
  const open = async () => {
    setBusy(true); setError(null)
    const f = await resolveFolder(path).catch((): FolderView => ({ error: 'could not reach the cockpit' }))
    setBusy(false)
    if (f.error || !f.path) { setError(f.error ?? 'not a folder'); return }
    onOpen(f.path, name.trim() || f.name || f.path, kind)
  }
  const rows = view?.dirs ?? []
  return (
    <Modal opened onClose={onClose} centered size="lg" radius="md" title={<Text fw={600}>Open a folder</Text>}>
      <Stack gap="md">
        <TextInput label="Folder" description="Click through the folders below, or type a path and press Enter." value={path} data-autofocus
          onChange={(e) => setPath(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') go(path) }} styles={{ input: { fontFamily: 'monospace' } }} />
        <div style={{ maxHeight: 280, overflowY: 'auto', border: '1px solid var(--ck-border)', borderRadius: 8 }}>
          {view === null && !error ? <Group gap="xs" p="sm"><Loader size="xs" /><Text size="xs" c="dimmed">loading…</Text></Group> : null}
          {view?.parent ? <FolderRow label=".." onClick={() => go(view.parent!)} /> : null}
          {rows.map((d) => <FolderRow key={d} label={d} onClick={() => go(view!.path + '/' + d)} />)}
          {view && !rows.length ? <Text size="xs" c="dimmed" p="sm">No folders inside.</Text> : null}
        </div>
        <TextInput label="Name" description="Shown in the sidebar; defaults to the folder's name." value={name} onChange={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') open() }} />
        <Stack gap={6}>
          <Label>First tab</Label>
          <SegmentedControl size="xs" value={kind} onChange={(v) => setKind(v as TabKind)}
            data={[{ value: 'claude', label: 'Claude' }, { value: 'shell', label: 'Terminal' }, { value: 'codex', label: 'Codex' }]} />
        </Stack>
        {error && <Alert color="red" variant="light">{error}</Alert>}
        <Group justify="flex-end"><Button onClick={open} loading={busy}>Open {path.trim() || 'folder'}</Button></Group>
      </Stack>
    </Modal>
  )
}

function FolderRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <UnstyledButton className="ck-space" onClick={onClick} style={{ display: 'block', width: '100%', padding: '6px 12px' }}>
      <Group gap={8} wrap="nowrap">
        <Text c="dimmed" style={{ display: 'flex', flex: 'none' }}>{label === '..' ? '↑' : '▸'}</Text>
        <Text size="sm" ff="monospace" truncate>{label === '..' ? '.. (up)' : label}</Text>
      </Group>
    </UnstyledButton>
  )
}

function Row({ icon, title, sub, mono, onClick }: { icon: ReactNode; title: string; sub: string; mono?: boolean; onClick: () => void }) {
  return (
    <UnstyledButton
      className="ck-space"
      onClick={onClick}
      style={{ borderRadius: 8, padding: '9px 11px', width: '100%', maxWidth: '100%', overflow: 'hidden', border: '1px solid var(--ck-border)' }}
    >
      <Group gap={10} wrap="nowrap" align="center" style={{ width: '100%', minWidth: 0 }}>
        <div style={{ color: 'var(--mantine-color-dimmed)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', width: 30 }}>{icon}</div>
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          <Text size="sm" fw={600} lh={1.3} ff={mono ? 'monospace' : undefined} truncate>{title}</Text>
          <Text size="xs" c="dimmed" ff="monospace" lh={1.3} truncate>{sub}</Text>
        </div>
        <Text c="dimmed" style={{ flex: 'none' }}>›</Text>
      </Group>
    </UnstyledButton>
  )
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
    </svg>
  )
}

function BranchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="2.4" /><circle cx="6" cy="18" r="2.4" /><circle cx="18" cy="7" r="2.4" />
      <path d="M6 8.4v7.2" /><path d="M18 9.4c0 4-3 5.6-6 5.6" />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.2h9A1.5 1.5 0 0 1 21 8.7v9.3a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z" />
    </svg>
  )
}
