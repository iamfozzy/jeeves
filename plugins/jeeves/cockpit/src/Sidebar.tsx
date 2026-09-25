import { useState } from 'react'
import { ActionIcon, Badge, Box, Button, Collapse, Group, Kbd, Popover, ScrollArea, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core'
import { IconArrowUpRight, IconFolder, IconFolderOpen, IconHome, IconLayoutGrid, IconPin, IconPinFilled, IconPlus, IconRobot, IconTerminal2 } from '@tabler/icons-react'
import { CloseConfirm } from './CloseConfirm'
import { Section } from './Section'
import { isHttpUrl } from './api'
import type { GitInfo, RepoCfg, Space, WorkerSpace, WorkerStatus } from './types'

export const WORKER_DOT: Record<WorkerStatus, string> = {
  working: 'var(--ck-yellow)',
  awaiting: 'var(--mantine-color-red-5)',
  idle: 'var(--mantine-color-blue-4)',
  blocked: 'var(--mantine-color-red-5)',
  done: 'var(--mantine-color-teal-5)',
  error: 'var(--mantine-color-red-6)',
  exited: 'var(--mantine-color-gray-6)'
}

// A space's dot reflects its claude tabs — the most attention-needing one wins.
// shell/codex tabs report nothing, so a space with none stays neutral grey.
// Lower = more attention-needing (wins the space dot). Typed over the full status
// set so a new status can't silently fall through to "least urgent".
const SESSION_RANK: Record<WorkerStatus, number> = { awaiting: 0, blocked: 0, error: 0, working: 1, done: 2, idle: 3, exited: 4 }
export function spaceDot(s: Space, ss: Record<string, string>): { color: string; label: string | null } {
  const statuses = s.tabs.filter((t) => t.kind === 'claude').map((t) => ss[`${s.id}:${t.id}`]).filter(Boolean)
  if (!statuses.length) return { color: 'var(--mantine-color-gray-6)', label: null }
  const rank = (st: string) => SESSION_RANK[st as WorkerStatus] ?? 9
  const best = [...statuses].sort((a, b) => rank(a) - rank(b))[0]
  return { color: WORKER_DOT[best as WorkerStatus] ?? 'var(--mantine-color-gray-6)', label: best }
}

// Git state for a space row: `dirty` shows the changed-file pill at the row's end, and
// `tooltip` spells everything out, ahead/behind included. Clean + in sync → null.
function gitState(git: GitInfo): { dirty: boolean; tooltip: string } | null {
  const tips: string[] = []
  if (git.changed > 0) tips.push(`${git.changed} uncommitted file${git.changed === 1 ? '' : 's'}`)
  // ahead/behind are against the tracked ref. When that isn't the branch's own remote
  // (a branch cut from origin/qa and never pushed tracks origin/qa), behind means the
  // base moved on — nothing to pull — and nothing of this branch is on origin yet.
  const own = !git.upstream || !git.branch || git.upstream.endsWith('/' + git.branch)
  const n = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`
  if (git.ahead > 0) tips.push(own ? `${n(git.ahead, 'commit')} to push` : `${n(git.ahead, 'commit')} not on origin`)
  if (git.behind > 0) tips.push(own ? `${n(git.behind, 'commit')} to pull` : `${n(git.behind, 'new commit')} on ${git.upstream}`)
  if (!own && (git.ahead > 0 || git.behind > 0)) tips.push('branch not pushed')
  return tips.length ? { dirty: git.changed > 0, tooltip: tips.join(' · ') } : null
}

// A labelled field in a sidebar detail card.
function CardField({ label, children }: { label: string; children: React.ReactNode }) {
  return <Box><Text className="ck-label" mb={3}>{label}</Text>{children}</Box>
}

// A Home row (Jeeves, Scratchpad), styled like a space row: lead mark, title and a
// short status on the right.
// The close-space confirm. A space that owns its worktree can delete it too; a
// refusal (uncommitted changes) turns the delete into a force delete.
function SpaceCloseBody({ space, title, ownsWorktree, onCancel, onClose }: {
  space: Space
  title: string
  ownsWorktree: boolean
  onCancel: () => void
  onClose: (worktree: 'keep' | 'delete' | 'force') => Promise<string | null>
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const run = async (wt: 'keep' | 'delete' | 'force') => {
    setBusy(true)
    try {
      setErr(await onClose(wt))
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed to close')
    } finally {
      setBusy(false)
    }
  }
  const refused = !!err && /uncommitted|refus/i.test(err)
  return (
    <Stack gap="xs">
      <Text size="sm">Close <b>{title}</b>?{ownsWorktree ? ' Its worktree can be deleted too.' : ''}</Text>
      {ownsWorktree ? <Text size="xs" c="dimmed" ff="monospace" style={{ wordBreak: 'break-all' }}>{space.cwd}</Text> : null}
      {err ? <Text size="xs" c="red">{err}</Text> : null}
      <Group justify="flex-end" gap="xs">
        <Button variant="default" size="xs" disabled={busy} onClick={onCancel}>Cancel</Button>
        {ownsWorktree ? (
          <>
            <Button variant="subtle" color="gray" size="xs" disabled={busy} onClick={() => run('keep')}>Keep worktree</Button>
            <Button color="red" size="xs" loading={busy} onClick={() => run(refused ? 'force' : 'delete')}>{refused ? 'Force delete' : 'Delete worktree'}</Button>
          </>
        ) : (
          <Button color="red" size="xs" data-autofocus onClick={() => run('keep')}>Close space</Button>
        )}
      </Group>
    </Stack>
  )
}

// Uncommitted changes: the file count in a small orange pill, a colour the claude
// status dot never uses, and a number where it's always a dot.
function ChangedPill({ n }: { n: number }) {
  return (
    <Box title={`${n} uncommitted file${n === 1 ? '' : 's'}`} className="ck-num"
      style={{ flex: 'none', fontSize: 10, fontWeight: 700, lineHeight: '14px', height: 14, minWidth: 14, padding: '0 4px', borderRadius: 7, textAlign: 'center', boxSizing: 'border-box',
        color: 'light-dark(var(--mantine-color-orange-8), var(--mantine-color-orange-4))', background: 'color-mix(in srgb, var(--mantine-color-orange-5) 18%, transparent)' }}>
      {n}
    </Box>
  )
}

// The ? button on a sidebar row: toggles a details card to the row's right. Clicks
// inside the card bubble through the React tree to the row, so they stop here.
function DetailsButton({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Popover position="right-start" offset={12} width={320} shadow="md" radius="md" withinPortal>
      <Popover.Target>
        <ActionIcon className="ck-x" size={20} variant="subtle" color="gray" aria-label={label}
          onClick={(e) => e.stopPropagation()} style={{ flex: 'none' }}>
          <span style={{ fontSize: 12, fontWeight: 700, lineHeight: 1 }}>?</span>
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown p={16} onClick={(e) => e.stopPropagation()}>
        <Stack gap={10}>{children}</Stack>
      </Popover.Dropdown>
    </Popover>
  )
}

function HomeRow({ active, onClick, title, lead, right }: {
  active: boolean; onClick: () => void; title: string; lead: React.ReactNode; right: string | null
}) {
  return (
    <UnstyledButton className="ck-space" data-active={active} onClick={onClick}
      style={{ borderRadius: 8, padding: '7px 9px', ...(active ? { background: 'var(--ck-active)' } : {}) }}>
      <Group gap={9} wrap="nowrap">
        <Box style={{ width: 14, display: 'flex', justifyContent: 'center', flex: 'none' }}>{lead}</Box>
        <Text size="sm" fw={600} lh={1.25} style={{ flex: 1, minWidth: 0 }} truncate>{title}</Text>
        {right ? <Text size="xs" c="dimmed" className="ck-num" style={{ flex: 'none' }}>{right}</Text> : null}
      </Group>
    </UnstyledButton>
  )
}

const FOLDERS = '~folders' // the Folders group's key in the collapsed map (never a repo id)

export function Sidebar({
  repos,
  spaces,
  workers,
  sessionStatus,
  activeSpaceId,
  gitBySpace,
  orchestratorActive,
  onSelectOrchestrator,
  scratchpadActive,
  onSelectScratchpad,
  orchStatus,
  scratchTabs,
  pinned,
  onTogglePin,
  onOpenPicker,
  onOpenSpaceRequest,
  onOpenFolderRequest,
  onSelectSpace,
  ownsWorktree,
  onCloseSpace,
  onOpenWorkerSpace,
  onCloseWorker
}: {
  repos: RepoCfg[]
  spaces: Space[]
  workers: WorkerSpace[]
  sessionStatus: Record<string, string>
  activeSpaceId: string | null
  gitBySpace: Record<string, GitInfo>
  orchestratorActive: boolean
  onSelectOrchestrator: () => void
  scratchpadActive: boolean
  onSelectScratchpad: () => void
  orchStatus?: string   // the orchestrator's hook status (working / awaiting / idle / exited)
  scratchTabs: number
  pinned: string[]
  onTogglePin: (repoId: string) => void
  onOpenPicker: () => void
  onOpenSpaceRequest: (repo: RepoCfg) => void
  onOpenFolderRequest: () => void
  onSelectSpace: (id: string) => void
  ownsWorktree: (s: Space) => boolean
  onCloseSpace: (id: string, worktree: 'keep' | 'delete' | 'force') => Promise<string | null>
  onOpenWorkerSpace: (w: WorkerSpace) => void
  onCloseWorker: (w: WorkerSpace) => void
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null) // the space whose close is being confirmed
  // Collapsed project headers, persisted per repo id.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('jeeves-cockpit-collapsed') || '{}') } catch { return {} }
  })
  const toggle = (id: string) => setCollapsed((c) => {
    const next = { ...c, [id]: !c[id] }
    try { localStorage.setItem('jeeves-cockpit-collapsed', JSON.stringify(next)) } catch {}
    return next
  })
  // Only repos with something in them (a space, a dispatched worker) or pinned, in an
  // order that never moves by itself: pinned repos in pin order, then by when the repo's
  // first space was opened, then worker-only repos in dispatch order. Status shows on
  // the dots, never in the order.
  const at = (i: number) => (i < 0 ? Infinity : i) // not found → after every found one
  const visible = repos
    .map((repo) => {
      const repoSpaces = spaces.filter((s) => s.repoId === repo.id)
      const repoWorkers = workers.filter((w) => w.repo === repo.id)
      const isPinned = pinned.includes(repo.id)
      return {
        repo, repoSpaces, repoWorkers, isPinned,
        pinAt: at(pinned.indexOf(repo.id)),
        spaceAt: at(spaces.findIndex((s) => s.repoId === repo.id)),
        workerAt: at(workers.findIndex((w) => w.repo === repo.id))
      }
    })
    .filter((r) => r.isPinned || r.repoSpaces.length || r.repoWorkers.length)
    .sort((a, b) => a.pinAt - b.pinAt || a.spaceAt - b.spaceAt || a.workerAt - b.workerAt || a.repo.slug.localeCompare(b.repo.slug))
  // One space row: status dot · branch (or name) · changes, with close.
  const spaceRow = (s: Space) => {
    const git = gitBySpace[s.id]
    const active = s.id === activeSpaceId
    const dot = spaceDot(s, sessionStatus)
    // The branch, or the space name when there's no git.
    const title = (git?.git && git.branch) || s.name
    const state = git?.git ? gitState(git) : null
    // One line: status dot · branch, then the uncommitted-file count on the right.
    return (
      <UnstyledButton
        key={s.id}
        component="div"
        role="button"
        tabIndex={0}
        className="ck-space"
        data-active={active}
        onClick={() => onSelectSpace(s.id)}
        onKeyDown={(e) => { if (e.target !== e.currentTarget) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectSpace(s.id) } }}
        // Indented under its repo (or Folders) header, clear of the tree line; the highlight stays full width.
        style={{ padding: '7px 12px 7px 20px', ...(active ? { background: 'var(--ck-active)' } : {}) }}
      >
        <Group gap={9} wrap="nowrap">
          <Box style={{ width: 14, display: 'flex', justifyContent: 'center', flex: 'none' }}>
            <Box
              w={7} h={7}
              style={{
                borderRadius: '50%', flex: 'none', boxSizing: 'border-box',
                ...(dot.label ? { background: dot.color } : { background: 'transparent', border: '1.5px solid var(--mantine-color-gray-6)' })
              }}
            />
          </Box>
          <Text size="sm" fw={600} lh={1.25} truncate style={{ minWidth: 0 }}>{title}</Text>
          <Box style={{ flex: 1 }} />
          {state?.dirty && git ? <ChangedPill n={git.changed} /> : null}
          <Group gap={6} wrap="nowrap" style={{ flex: 'none' }}>
          <CloseConfirm opened={confirmId === s.id} onChange={(o) => setConfirmId(o ? s.id : null)} label="Close space" size={20}>
            <SpaceCloseBody space={s} title={title} ownsWorktree={ownsWorktree(s)}
              onCancel={() => setConfirmId(null)} onClose={(wt) => onCloseSpace(s.id, wt)} />
          </CloseConfirm>
          </Group>
        </Group>
      </UnstyledButton>
    )
  }
  const folders = spaces.filter((s) => !s.repoId)
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘P' : 'Ctrl+P'
  // When every configured repo shares an owner, headers drop it (it's noise);
  // otherwise the full slug disambiguates.
  const owners = new Set(repos.map((r) => r.slug.split('/')[0]))
  const sharedOwner = owners.size === 1 ? repos[0]?.slug.split('/')[0] ?? null : null
  return (
    <Stack gap={0}>
      <Section id="side:home" label="Home" icon={IconHome} accent="gray" px="sm" collapsible={false}>
      <Stack gap={2} px={6} pt={6} pb={6}>
        <HomeRow active={orchestratorActive} onClick={onSelectOrchestrator} title="Jeeves"
          lead={
            <Box pos="relative" style={{ display: 'flex' }}>
              <img src="/brand/jeeves-mark.svg" alt="" width={14} height={14} style={{ display: 'block' }} />
              {orchStatus ? (
                <Box className="ck-badge" pos="absolute" w={6} h={6} right={-2} bottom={-1}
                  style={{ borderRadius: '50%', background: WORKER_DOT[orchStatus as WorkerStatus] ?? 'var(--mantine-color-gray-6)' }} />
              ) : null}
            </Box>
          }
          right={orchStatus ?? null} />
        <HomeRow active={scratchpadActive} onClick={onSelectScratchpad} title="Scratchpad"
          lead={<Box style={{ display: 'flex', color: 'var(--mantine-color-dimmed)' }}><IconTerminal2 size={14} stroke={2} /></Box>}
          right={`${scratchTabs} tab${scratchTabs === 1 ? '' : 's'}`} />
      </Stack>
      </Section>

      <Section
        id="side:spaces" icon={IconLayoutGrid} label="Spaces" count={spaces.length} accent="cockpit" px="sm"
        right={repos.length ? (
          <Tooltip label={<>Open space… <Kbd size="xs">{mod}</Kbd></>} openDelay={300} withArrow>
            <ActionIcon size={20} variant="subtle" color="gray" onClick={onOpenPicker} aria-label="Open space">
              <IconPlus size={14} stroke={2.2} />
            </ActionIcon>
          </Tooltip>
        ) : null}
      >
      {repos.length === 0 ? (
        <Box px="sm" py="sm"><Text size="xs" c="dimmed">No repos configured. Run <Text span ff="monospace">/jeeves:setup</Text> in a Claude session.</Text></Box>
      ) : null}
      {/* Folder spaces: any folder, no repo — for work that isn't a configured project. */}
      <Box>
        <Group gap={6} wrap="nowrap" px="sm" py={7} className="ck-proj" onClick={() => toggle(FOLDERS)}>
          <Box style={{ display: 'flex', flex: 'none', marginRight: 3, color: 'var(--mantine-color-dimmed)' }}>
            {!collapsed[FOLDERS] && folders.length ? <IconFolderOpen size={14} stroke={2} /> : <IconFolder size={14} stroke={2} />}
          </Box>
          <Text size="xs" fw={600} style={{ letterSpacing: '.01em', color: 'var(--ck-repo)', flex: 1, minWidth: 0 }} truncate>Folders</Text>
          {collapsed[FOLDERS] && folders.length ? <Badge size="xs" variant="light" color="gray" style={{ flex: 'none' }}>{folders.length}</Badge> : null}
          <Tooltip label="Open a folder" openDelay={400} withArrow>
            <ActionIcon size={20} variant="subtle" color="gray" onClick={(e) => { e.stopPropagation(); onOpenFolderRequest() }} aria-label="Open folder" style={{ flex: 'none' }}>
              <IconPlus size={14} stroke={2.2} />
            </ActionIcon>
          </Tooltip>
        </Group>
        <Collapse expanded={!collapsed[FOLDERS] && folders.length > 0}>
          <Stack gap={0} className="ck-tree">{folders.map((s) => spaceRow(s))}</Stack>
        </Collapse>
      </Box>
      {visible.map(({ repo, repoSpaces, repoWorkers, isPinned }) => {
        const isCollapsed = !!collapsed[repo.id]
        return (
          <Box key={repo.id}>
            <Group gap={6} wrap="nowrap" px="sm" py={7} className="ck-proj" onClick={() => toggle(repo.id)}>
              {/* The folder sits over the space rows' status-dot column; the extra 3px lines the repo name up with theirs. */}
              <Box style={{ display: 'flex', flex: 'none', marginRight: 3, color: 'var(--mantine-color-cockpit-4)' }}>
                {!isCollapsed && repoSpaces.length ? <IconFolderOpen size={14} stroke={2} /> : <IconFolder size={14} stroke={2} />}
              </Box>
              <Tooltip label={repo.slug} openDelay={400} withArrow disabled={!sharedOwner}>
                <Text size="xs" fw={600} style={{ letterSpacing: '.01em', color: 'var(--ck-repo)', flex: 1, minWidth: 0 }} truncate>
                  {sharedOwner ? repo.slug.slice(sharedOwner.length + 1) : repo.slug}
                </Text>
              </Tooltip>
              {repoWorkers.length ? (
                <Tooltip label={`${repoWorkers.length} ${repoWorkers.length === 1 ? 'agent' : 'agents'}`} openDelay={400} withArrow>
                  <Badge size="xs" variant="light" color="yellow" leftSection={<IconRobot size={10} />} style={{ flex: 'none' }}>{repoWorkers.length}</Badge>
                </Tooltip>
              ) : null}
              {isCollapsed && repoSpaces.length ? (
                <Tooltip label={`${repoSpaces.length} open space${repoSpaces.length === 1 ? '' : 's'}`} openDelay={400} withArrow>
                  <Badge size="xs" variant="light" color="cockpit" style={{ flex: 'none' }}>{repoSpaces.length}</Badge>
                </Tooltip>
              ) : null}
              <Tooltip label={isPinned ? 'Unpin from sidebar' : 'Pin to sidebar'} openDelay={400} withArrow>
                <ActionIcon
                  className={isPinned ? undefined : 'ck-x'}
                  size={20}
                  variant="subtle"
                  color={isPinned ? 'cockpit' : 'gray'}
                  onClick={(e) => { e.stopPropagation(); onTogglePin(repo.id) }}
                  aria-label={isPinned ? 'Unpin repo' : 'Pin repo'}
                  style={{ flex: 'none' }}
                >
                  {isPinned ? <IconPinFilled size={13} /> : <IconPin size={13} />}
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Open a space in this repo" openDelay={400} withArrow>
                <ActionIcon size={20} variant="subtle" color="gray" onClick={(e) => { e.stopPropagation(); onOpenSpaceRequest(repo) }} aria-label="Open space" style={{ flex: 'none' }}>
                  <IconPlus size={14} stroke={2.2} />
                </ActionIcon>
              </Tooltip>
            </Group>

            <Collapse expanded={!isCollapsed && repoSpaces.length > 0}>
                  <Stack gap={0} className="ck-tree">
                    {repoSpaces.map((s) => spaceRow(s))}
                  </Stack>
            </Collapse>
          </Box>
        )
      })}
      </Section>

      {workers.length > 0 && (
        <Section id="side:agents" icon={IconRobot} label="Agents" count={workers.length} accent="yellow" px="sm">
          <Stack gap={0}>
            {workers.map((w) => {
              const active = activeSpaceId === 'work:' + w.workId
              const title = `${w.agent} · ${w.ticket || w.branch}`
              // One line, like a space: status dot · agent and ticket; the rest behind the ? button.
              return (
                <UnstyledButton
                  key={w.workId}
                  component="div"
                  role="button"
                  tabIndex={0}
                  className="ck-space"
                  data-active={active}
                  onClick={() => onSelectSpace('work:' + w.workId)}
                  onKeyDown={(e) => { if (e.target !== e.currentTarget) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectSpace('work:' + w.workId) } }}
                  style={{ padding: '7px 12px', ...(active ? { background: 'var(--ck-active)' } : {}) }}
                >
                  <Group gap={9} wrap="nowrap">
                    <Box style={{ width: 14, display: 'flex', justifyContent: 'center', flex: 'none' }}>
                      <Box w={7} h={7} style={{ borderRadius: '50%', background: WORKER_DOT[w.status], flex: 'none' }} />
                    </Box>
                    <Text size="sm" fw={600} lh={1.25} truncate style={{ minWidth: 0 }}>{title}</Text>
                    <Box style={{ flex: 1 }} />
                    <Group gap={6} wrap="nowrap" style={{ flex: 'none' }}>
                      <DetailsButton label="Worker details">
                        <Box>
                          <Text size="xs" c="dimmed" mb={2}>{w.repoSlug}</Text>
                          <Text size="sm" fw={600} lh={1.4} style={{ wordBreak: 'break-word' }}>{title}</Text>
                        </Box>
                        <CardField label="Status"><Text size="sm">{w.status}</Text></CardField>
                        <CardField label="Branch"><Text size="sm" style={{ wordBreak: 'break-word' }}>{w.branch}</Text></CardField>
                        <CardField label="Worktree"><Text size="xs" ff="monospace" style={{ wordBreak: 'break-all' }}>{w.cwd}</Text></CardField>
                        {w.pr ? <CardField label="PR"><Text size="sm" style={{ wordBreak: 'break-all' }}>{isHttpUrl(w.pr) ? <a className="ck-link" href={w.pr} target="_blank" rel="noreferrer">{w.pr}</a> : w.pr}</Text></CardField> : null}
                        {w.summary ? (
                          <CardField label="Summary">
                            <ScrollArea.Autosize mah={160} type="auto">
                              <Text size="xs" style={{ whiteSpace: 'pre-wrap' }}>{w.summary}</Text>
                            </ScrollArea.Autosize>
                          </CardField>
                        ) : null}
                      </DetailsButton>
                      <Tooltip label="Open your own space in this worktree" openDelay={400} withArrow>
                        <ActionIcon className="ck-x" size={20} variant="subtle" color="gray" aria-label="Investigate in a new space" style={{ flex: 'none' }}
                          onClick={(e) => { e.stopPropagation(); onOpenWorkerSpace(w) }}>
                          <IconArrowUpRight size={14} />
                        </ActionIcon>
                      </Tooltip>
                      <ActionIcon className="ck-x" size={20} variant="subtle" color="gray" aria-label="Close worker" style={{ flex: 'none' }}
                        onClick={(e) => { e.stopPropagation(); onCloseWorker(w) }}>
                        <span style={{ fontSize: 13, lineHeight: 1 }}>×</span>
                      </ActionIcon>
                    </Group>
                  </Group>
                </UnstyledButton>
              )
            })}
          </Stack>
        </Section>
      )}
    </Stack>
  )
}
