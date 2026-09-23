import { useEffect, useState } from 'react'
import { Badge, Box, Button, Group, Stack, Tabs, Text, TextInput, Tooltip, UnstyledButton } from '@mantine/core'
import { IconArrowBackUp, IconChevronRight, IconFolder, IconSearch } from '@tabler/icons-react'
import { getChanges, getPrStatus, revertFile } from './api'
import { CloseConfirm } from './CloseConfirm'
import { DiffModal } from './DiffModal'
import { PrPane, prBadge } from './PrModal'
import type { Changes, ChangedFile, PrStatus } from './types'

const KIND_COLOR: Record<ChangedFile['kind'], string> = {
  added: 'var(--mantine-color-teal-5)',
  modified: 'var(--ck-yellow)',
  deleted: 'var(--mantine-color-red-5)',
  renamed: 'var(--mantine-color-cockpit-4)'
}
const KIND_LETTER: Record<ChangedFile['kind'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }
// The in-space right panel (the branch itself is on the sidebar row): tabs — Changes (uncommitted, each file
// revertible after a confirm), All (the branch against its PR's base, else the
// project's base branch) and, when the branch has one, PR. Both file lists poll
// together so each tab shows its count; a file opens a read-only Monaco diff.
type Tab = 'changes' | 'all' | 'pr'
export function SpacePanel({ cwd, repoId, active }: { cwd: string; repoId?: string; active: boolean }) {
  const [changes, setChanges] = useState<Changes | null>(null)
  const [all, setAll] = useState<Changes | null>(null)
  const [pr, setPr] = useState<PrStatus | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('changes')

  const base = pr?.pr?.base || pr?.defaultBase || undefined
  const hasPr = !!(repoId && pr?.pr)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    let inFlight = false // skip a tick if the previous git/gh calls haven't settled — gh's timeout (15s) is 3× the interval
    const poll = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const [c, p, a] = await Promise.all([getChanges(cwd), getPrStatus(cwd), base ? getChanges(cwd, base) : null])
        if (!cancelled) { setChanges(c); setPr(p); if (a) setAll(a) }
      } finally { inFlight = false }
    }
    poll()
    const iv = window.setInterval(poll, 5000)
    return () => { cancelled = true; clearInterval(iv) }
  }, [cwd, active, base])

  useEffect(() => setAll(null), [base])
  // The PR tab goes when the branch's PR does.
  useEffect(() => { if (tab === 'pr' && pr && !hasPr) setTab('changes') }, [tab, pr, hasPr])

  const revert = async (path: string) => {
    const r = await revertFile(cwd, path)
    if (!r.error) getChanges(cwd).then(setChanges).catch(() => {})
    return r.error
  }
  const noGit = changes?.git === false
  const badge = pr?.pr ? prBadge(pr.pr) : null
  const count = (c: Changes | null) => c?.files.length ? <Badge size="xs" variant="light" color="gray" className="ck-num">{c.files.length}</Badge> : null

  return (
    <div className="ck-sidepanel" style={{ width: 300, flex: 'none', height: '100%', overflowY: 'auto', background: 'var(--ck-surface)', borderLeft: '1px solid var(--ck-border)' }}>
      {noGit ? <Box px="md" py="sm"><Text size="xs" c="dimmed">not a git worktree</Text></Box> : (
        <>
          <Tabs value={tab} onChange={(v) => v && setTab(v as Tab)} color="cockpit" className="ck-ptabs">
            <Tabs.List>
              <Tabs.Tab value="changes" rightSection={count(changes)}>Changes</Tabs.Tab>
              <Tabs.Tab value="all" disabled={!base} rightSection={count(all)}>All</Tabs.Tab>
              {hasPr && badge ? (
                <Tabs.Tab value="pr" leftSection={<badge.icon size={13} stroke={2.2} style={{ color: `var(--mantine-color-${badge.color}-5)` }} />}>PR</Tabs.Tab>
              ) : null}
            </Tabs.List>
          </Tabs>

          {tab === 'changes' ? (
            <FileList files={changes?.files ?? []} empty="working tree clean" onOpen={setSelected} onRevert={revert} />
          ) : tab === 'all' ? (
            <FileList files={all?.files ?? []} empty={all ? `no changes against ${base}` : 'loading…'} against={base} onOpen={setSelected} />
          ) : hasPr && repoId && pr?.pr ? (
            <PrPane repoId={repoId} number={pr.pr.number} checks={pr.checks} state={badge?.label} />
          ) : null}
        </>
      )}

      <DiffModal cwd={cwd} path={selected} base={tab === 'all' ? base : undefined} onClose={() => setSelected(null)} />
    </div>
  )
}

// Changed files grouped by folder: a header per folder (collapsible; all start
// collapsed past 40 files), files beneath by name with a status badge and +/−
// line counts, a filter strip past 15 files, and totals in the section header.
const COLLAPSE_OVER = 40
const FILTER_OVER = 15
type Revert = (path: string) => Promise<string | undefined>
function FileList({ files, empty, against, onOpen, onRevert }: {
  files: ChangedFile[]; empty: string; against?: string; onOpen: (path: string) => void; onRevert?: Revert
}) {
  const [q, setQ] = useState('')
  const [confirm, setConfirm] = useState<string | null>(null)
  const [toggled, setToggled] = useState<Set<string>>(new Set())
  const needle = q.trim().toLowerCase()
  const shown = needle ? files.filter((f) => f.path.toLowerCase().includes(needle)) : files
  const groups = new Map<string, ChangedFile[]>()
  for (const f of shown) {
    const slash = f.path.lastIndexOf('/')
    const dir = slash >= 0 ? f.path.slice(0, slash) : ''
    groups.set(dir, [...(groups.get(dir) ?? []), f])
  }
  const collapsedByDefault = files.length > COLLAPSE_OVER && !needle
  const isOpen = (dir: string) => collapsedByDefault === toggled.has(dir)
  const toggle = (dir: string) => setToggled((t) => { const n = new Set(t); if (n.has(dir)) n.delete(dir); else n.add(dir); return n })
  const add = files.reduce((n, f) => n + (f.add ?? 0), 0)
  const del = files.reduce((n, f) => n + (f.del ?? 0), 0)

  return (
    <>
      {files.length ? (
        <Group gap={8} px="md" py={7} wrap="nowrap" style={{ borderBottom: '1px solid var(--ck-divider)' }}>
          <Text size="xs" c="dimmed" truncate style={{ flex: 1, minWidth: 0 }}>
            {files.length} file{files.length === 1 ? '' : 's'}{against ? <> vs <Text span inherit ff="monospace">{against}</Text></> : null}
          </Text>
          {add || del ? (
            <Text size="xs" className="ck-num" style={{ flex: 'none' }}>
              <Text span inherit c="teal">+{add.toLocaleString()}</Text>{' '}<Text span inherit c="red">−{del.toLocaleString()}</Text>
            </Text>
          ) : null}
        </Group>
      ) : null}

      {files.length > FILTER_OVER ? (
        <Box px={6} style={{ borderBottom: '1px solid var(--ck-divider)' }}>
          <TextInput variant="unstyled" size="sm" placeholder={`Filter ${files.length} files…`} leftSection={<IconSearch size={14} />}
            value={q} onChange={(e) => setQ(e.currentTarget.value)} styles={{ input: { height: 36 } }} />
        </Box>
      ) : null}

      {files.length === 0 ? <Box px="md" py="sm"><Text size="xs" c="dimmed">{empty}</Text></Box>
        : shown.length === 0 ? <Box px="md" py="sm"><Text size="xs" c="dimmed">No file matches “{q}”.</Text></Box>
        : [...groups].map(([dir, list]) => (
          <Box key={dir || '.'} pb={2}>
            <UnstyledButton className="ck-row" w="100%" px="md" py={6} onClick={() => toggle(dir)} title={dir || 'repository root'}>
              <Group gap={6} wrap="nowrap">
                <IconChevronRight size={12} stroke={2.4} style={{ flex: 'none', color: 'var(--mantine-color-dimmed)', transform: isOpen(dir) ? 'rotate(90deg)' : undefined, transition: 'transform 120ms' }} />
                <IconFolder size={14} stroke={2} style={{ flex: 'none', color: 'var(--mantine-color-dimmed)' }} />
                {/* rtl keeps the deepest folders visible when the path is cut */}
                <Text size="xs" c="dimmed" ff="monospace" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}>
                  <bdi>{dir || './'}</bdi>
                </Text>
                <Text size="xs" c="dimmed" className="ck-num" style={{ flex: 'none' }}>{list.length}</Text>
              </Group>
            </UnstyledButton>
            {isOpen(dir) ? list.map((f) => (
              <FileRow key={f.path} f={f} onOpen={onOpen} onRevert={onRevert}
                confirming={confirm === f.path} onConfirm={(o) => setConfirm(o ? f.path : null)} />
            )) : null}
          </Box>
        ))}
    </>
  )
}

function FileRow({ f, onOpen, onRevert, confirming, onConfirm }: {
  f: ChangedFile; onOpen: (path: string) => void; onRevert?: Revert; confirming: boolean; onConfirm: (opened: boolean) => void
}) {
  const name = f.path.slice(f.path.lastIndexOf('/') + 1)
  const untracked = f.xy === '??'
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ask = (o: boolean) => { setError(null); onConfirm(o) }
  const doRevert = async () => {
    if (!onRevert) return
    setBusy(true)
    const err = await onRevert(f.path).catch((e: Error) => e.message)
    setBusy(false)
    if (err) setError(err); else onConfirm(false)
  }
  return (
    <Group className="ck-row ck-file" gap={8} wrap="nowrap" pl={38} pr={onRevert ? 6 : 'md'} py={5} onClick={() => onOpen(f.path)} title={f.path}
      style={{ cursor: 'pointer' }}>
      <Tooltip label={untracked ? 'new, untracked' : `${f.kind}${f.staged ? ' · staged' : ''}`} openDelay={400} withArrow position="left">
        <Box style={{
          flex: 'none', width: 16, height: 16, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 10, fontWeight: 700, fontFamily: 'var(--mantine-font-family-monospace)',
          color: KIND_COLOR[f.kind], background: `color-mix(in srgb, ${KIND_COLOR[f.kind]} 16%, transparent)`
        }}>{KIND_LETTER[f.kind]}</Box>
      </Tooltip>
      <Text size="xs" ff="monospace" fw={500} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</Text>
      <Text size="xs" className="ck-num" style={{ flex: 'none' }}>
        {f.add != null ? <><Text span inherit c="teal">+{f.add}</Text>{' '}<Text span inherit c="red">−{f.del}</Text></> : <Text span inherit c="dimmed">{untracked ? 'new' : 'bin'}</Text>}
      </Text>
      {onRevert ? (
        <CloseConfirm opened={confirming} onChange={ask} label="Revert file" size={18} icon={<IconArrowBackUp size={13} stroke={2} />}>
          <Stack gap="xs">
            <Text size="sm">
              {untracked ? <>Delete <b>{name}</b>? It's untracked, so it can't be recovered.</>
                : <>Revert <b>{name}</b> to HEAD? Its uncommitted changes{f.staged ? ', staged included,' : ''} are lost.</>}
            </Text>
            {error ? <Text size="xs" c="red">{error}</Text> : null}
            <Group justify="flex-end" gap="xs">
              <Button variant="default" size="xs" onClick={() => ask(false)}>Cancel</Button>
              <Button color="red" size="xs" data-autofocus loading={busy} onClick={doRevert}>{untracked ? 'Delete' : 'Revert'}</Button>
            </Group>
          </Stack>
        </CloseConfirm>
      ) : null}
    </Group>
  )
}
