import { useState } from 'react'
import { ActionIcon, Badge, Box, Group, HoverCard, Menu, Select, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core'
import {
  IconAlarm, IconAlertTriangle, IconCircleCheck, IconExternalLink, IconFileSearch,
  IconGitPullRequest, IconListDetails, IconLoader2, IconSearch, IconTestPipe
} from '@tabler/icons-react'
import { sendOrchInput } from './api'
import { PrModal } from './PrModal'
import { Section } from './Section'
import type { Checks, Dot, RepoCfg, Story, StoryPhase, SurfaceAction, Surface, WorkerSpace } from './types'

const DOT_VAR: Record<Dot, string> = {
  red: 'var(--mantine-color-red-6)',
  yellow: 'var(--ck-yellow)',
  green: 'var(--mantine-color-teal-5)',
  white: 'var(--mantine-color-gray-6)'
}
const RANK: Record<Dot, number> = { red: 0, yellow: 1, white: 2, green: 3 }
const CHECKS: Record<Checks, { icon: typeof IconFileSearch; color: string; label: string }> = {
  pass: { icon: IconCircleCheck, color: DOT_VAR.green, label: 'Checks passing' },
  fail: { icon: IconAlertTriangle, color: DOT_VAR.red, label: 'Checks failing' },
  pending: { icon: IconLoader2, color: DOT_VAR.yellow, label: 'Checks running' }
}

// Story phase → badge colour + label.
const PHASE: Record<StoryPhase, { color: string; label: string }> = {
  'needs-plan': { color: 'red', label: 'needs plan' },
  planning: { color: 'yellow', label: 'planning' },
  'awaiting-approval': { color: 'yellow', label: 'awaiting approval' },
  approved: { color: 'teal', label: 'approved' },
  'in-progress': { color: 'cockpit', label: 'in progress' },
  'in-review': { color: 'blue', label: 'in review' },
  blocked: { color: 'red', label: 'blocked' },
  done: { color: 'teal', label: 'done' }
}

const filled = (s?: string): s is string => Boolean(s && s.trim().length > 0)
const hashOf = (text: string): string | undefined => text.match(/#(\d+)/)?.[1]
// A row with no dot is neutral: drawn and ranked as white, and collapsed with the calm rows.
const byRank = <T extends { dot?: Dot }>(a: T, b: T) => RANK[a.dot ?? 'white'] - RANK[b.dot ?? 'white']
const urgent = (d?: Dot) => d === 'red' || d === 'yellow'
// Approved (a plan, or a PR waiting on the user's merge): calm by dot, but never folded away.
// Not for reviews, where "approved" means the user already approved it.
const approved = (r: AnyRow) => r.checks !== 'fail'
  && [r.phase, r.state, r.status, r.next, r.item].some((t) => /\bapproved\b|ready to merge|mergeable/i.test(t ?? ''))
const FILTER_KEY = 'jeeves-cockpit-repo-filter'

type AnyRow = { item: string; repo?: string; dot?: Dot; number?: string | number; key?: string; phase?: StoryPhase; state?: string; status?: string; next?: string; checks?: Checks }
// A sorted row plus its rank position and identity.
type View<T> = { r: T; n: number; id: string }

export function Dashboard({ repos, surface, workers }: { repos: RepoCfg[]; surface: Surface; workers: WorkerSpace[] }) {
  const [sent, setSent] = useState<string | null>(null)
  const [prModal, setPrModal] = useState<{ repoId: string; number: string | number; title?: string } | null>(null)
  const flash = (k: string) => { setSent(k); window.setTimeout(() => setSent((s) => (s === k ? null : s)), 1400) }
  const fire = (a: SurfaceAction) => { if (!a.run) return; sendOrchInput(a.run, !a.type).catch(() => {}); flash(a.run) }

  // Open a PR/review row's description in a modal. Only when the repo resolves.
  const openPr = (repo?: string, num?: string | number, title?: string) => {
    const rc = repoFor(repo)
    if (rc && num != null) setPrModal({ repoId: rc.id, number: String(num).replace(/^#/, ''), title })
  }

  const repoFor = (tag?: string): RepoCfg | undefined => {
    if (!tag) return repos.length === 1 ? repos[0] : undefined
    return repos.find((r) => r.id === tag || r.slug === tag || r.slug.split('/').pop() === tag || r.slug.endsWith('/' + tag))
      ?? (repos.length === 1 ? repos[0] : undefined)
  }

  // Repo tag → repo id, so every spelling of a repo groups and filters together.
  const repoKey = (tag?: string) => (tag ? repoFor(tag)?.id ?? tag : '')
  // Row identity, matching surface_render's: "<repo>#<number>" or "<repo>:<KEY>".
  const rowId = (pr: boolean, r: AnyRow) => {
    const id = pr
      ? (r.number != null && String(r.number).replace(/^#/, '').trim()) || r.item.match(/^\s*#(\d+)/)?.[1]
      : r.key?.trim() || r.item.match(/^\s*([A-Z][A-Z0-9]*-\d+)/)?.[1]
    return id ? repoKey(r.repo) + (pr ? '#' : ':') + id : undefined
  }

  const [filter, setFilter] = useState<string | null>(() => { try { return localStorage.getItem(FILTER_KEY) } catch { return null } })
  const pickFilter = (k: string | null) => {
    try { if (k) localStorage.setItem(FILTER_KEY, k); else localStorage.removeItem(FILTER_KEY) } catch {}
    setFilter(k)
  }
  // Sections whose calm (green / no-dot) rows are expanded.
  const [openCalm, setOpenCalm] = useState<Record<string, boolean>>({})

  const s = surface
  const sorted = <T extends AnyRow>(pr: boolean, rows?: T[]): View<T>[] =>
    [...(rows ?? [])].sort(byRank).map((r, n) => ({ r, n, id: rowId(pr, r) ?? `@${n}` }))
  const all = {
    stories: sorted(false, s?.stories), myPrs: sorted(true, s?.myPrs),
    qa: sorted(false, s?.qa), reviews: sorted(true, s?.reviews)
  }
  const allInFlight = s?.inFlight?.length
    ? s.inFlight.map((f) => ({ text: f.text, repo: f.repo }))
    : workers.filter((w) => w.status === 'working').map((w) => ({ text: `${w.agent} → ${w.ticket || w.branch}`, repo: w.repoSlug }))

  // Repo filter options: only the repos present in the current rows, with row counts.
  const repoCounts = new Map<string, number>()
  for (const tag of [...Object.values(all).flat().map((v) => v.r.repo), ...allInFlight.map((f) => f.repo)]) {
    const k = repoKey(tag)
    if (k) repoCounts.set(k, (repoCounts.get(k) ?? 0) + 1)
  }
  const repoOptions = [...repoCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const active = repoOptions.length > 1 && filter && repoCounts.has(filter) ? filter : null
  const inRepo = (tag?: string) => !active || repoKey(tag) === active
  const stories = all.stories.filter((v) => inRepo(v.r.repo))
  const myPrs = all.myPrs.filter((v) => inRepo(v.r.repo))
  const qa = all.qa.filter((v) => inRepo(v.r.repo))
  const reviews = all.reviews.filter((v) => inRepo(v.r.repo))
  const inFlight = allInFlight.filter((f) => inRepo(f.repo))

  // A section body: red/yellow and approved rows in full, calm rows folded behind one toggle line.
  const body = <T extends AnyRow>(sec: string, list: View<T>[], render: (v: View<T>, i: number) => React.ReactNode) => {
    const pinned = (r: T) => urgent(r.dot) || (sec !== 'reviews' && approved(r))
    const calm = list.filter((v) => !pinned(v.r)).length
    const shown = openCalm[sec] ? list : list.filter((v) => pinned(v.r))
    return (
      <>
        {shown.map(render)}
        {calm > 0 && (
          <UnstyledButton w="100%" px="md" py={7} className="ck-row"
            onClick={() => setOpenCalm((o) => ({ ...o, [sec]: !o[sec] }))}>
            <Group gap={9} wrap="nowrap">
              <Box w={7} h={7} style={{ borderRadius: '50%', background: DOT_VAR.green, flex: 'none' }} />
              <Text size="xs" c="dimmed">{openCalm[sec] ? `Hide ${calm} on track` : `${calm} on track — show`}</Text>
            </Group>
          </UnstyledButton>
        )}
      </>
    )
  }

  // Reminders are personal, not per repo: never filtered or folded, always on top.
  const reminders = [...(s?.reminders ?? [])].sort(byRank)
  const anything = reminders.length || stories.length || myPrs.length || qa.length || reviews.length

  // Shared row: icon (dot-coloured) · text (+ optional sub-line) · right slot · actions.
  // When ghNum is set the row expands to show the PR description (fetched on open).
  // Called as a plain function (not <Row/>) so rows don't remount on every paint —
  // an inline component type would reset hover/tooltips and open menus each render.
  // Hovering a row opens a card to its left, over the terminal: the same data as the
  // row, laid out with room and nothing truncated (`details` = labelled fields).
  const row = ({ k, dot, Icon, text, repo, sub, right, actions, ghNum, details }: {
    k: string; dot?: Dot; Icon: typeof IconFileSearch; text: string; repo?: string
    sub?: React.ReactNode; right?: React.ReactNode; actions?: SurfaceAction[]; ghNum?: string | number
    details?: [string, React.ReactNode][]
  }) => {
    const expandable = ghNum != null && !!repoFor(repo)
    const shown = (details ?? []).filter(([, v]) => v != null && v !== '' && v !== false)
    return (
      <HoverCard key={k} position="left-start" offset={14} width={380} shadow="md" radius="md"
        openDelay={450} closeDelay={80} withinPortal>
      <HoverCard.Target>
      <Box px="md" py={10} className="ck-row">
        <Group align="flex-start" justify="space-between" wrap="nowrap" gap="sm">
          <Group align="flex-start" wrap="nowrap" gap={10} className={expandable ? 'ck-prrow' : undefined}
            style={{ minWidth: 0, cursor: expandable ? 'pointer' : 'default' }}
            onClick={expandable ? () => openPr(repo, ghNum, text) : undefined}
            title={expandable ? 'View description' : undefined}>
            <Box style={{ color: DOT_VAR[dot ?? 'white'], flex: 'none', display: 'flex', alignItems: 'center', height: 20 }}>
              <Icon size={17} stroke={2} />
            </Box>
            <Box style={{ minWidth: 0 }}>
              <Text size="sm" lh={1.45}>
                {repo ? <Text span c="dimmed" size="xs">{repo} · </Text> : null}
                <Linked text={text} repo={repoFor(repo)} repos={repos} />
              </Text>
              {sub ? <Box mt={3}>{sub}</Box> : null}
            </Box>
          </Group>
          <Group gap={6} wrap="nowrap" align="center" style={{ flex: 'none' }}>
            {right}
            <Actions actions={actions} repo={repoFor(repo)} ghNum={ghNum} sent={sent} fire={fire} />
          </Group>
        </Group>
      </Box>
      </HoverCard.Target>
      <HoverCard.Dropdown p={16}>
        <Stack gap={12}>
          <Group gap={10} wrap="nowrap" align="flex-start">
            <Box style={{ color: DOT_VAR[dot ?? 'white'], flex: 'none', display: 'flex', paddingTop: 2 }}><Icon size={18} stroke={2} /></Box>
            <Box style={{ minWidth: 0 }}>
              {repo ? <Text size="xs" c="dimmed" mb={2}>{repo}</Text> : null}
              <Text size="sm" fw={600} lh={1.5}><Linked text={text} repo={repoFor(repo)} repos={repos} /></Text>
            </Box>
          </Group>
          {shown.length ? (
            <Stack gap={10}>
              {shown.map(([label, v]) => (
                <Box key={label}>
                  <Text className="ck-label" mb={3}>{label}</Text>
                  {typeof v === 'string' ? <Text size="sm" lh={1.5}><Linked text={v} repo={repoFor(repo)} repos={repos} /></Text> : v}
                </Box>
              ))}
            </Stack>
          ) : null}
          {expandable ? <Text size="xs" c="dimmed">Click the row for the full description.</Text> : null}
        </Stack>
      </HoverCard.Dropdown>
      </HoverCard>
    )
  }

  return (
    <Stack gap={0} p={0} pb="md">
      {!s && <Box px="md" py="sm"><Muted>Waiting for the orchestrator to paint this pane via surface_render.</Muted></Box>}

      {repoOptions.length > 1 && (
        <Box px={6} style={{ borderBottom: '1px solid var(--ck-divider)' }}>
          <Select
            variant="unstyled" size="sm" searchable clearable
            leftSection={<IconSearch size={15} stroke={2} />}
            styles={{ input: { height: 44 } }}
            placeholder={`All repos (${repoOptions.length})`}
            nothingFoundMessage="No repo with rows"
            data={repoOptions.map(([k, n]) => ({ value: k, label: `${k} (${n})` }))}
            value={active}
            onChange={pickFilter}
            comboboxProps={{ withinPortal: true }}
            aria-label="Filter by repo"
          />
        </Box>
      )}

      {reminders.length > 0 && (
        <Section id="dash:reminders" label="Reminders" count={reminders.length} icon={IconAlarm} accent="red">
          {reminders.map((rm) => row({
            k: rm.id, dot: rm.dot, Icon: IconAlarm, text: rm.item, actions: rm.actions,
            details: [['Due', rm.due]],
            sub: rm.due ? <Text size="xs" c="dimmed" lh={1.4}>due {rm.due}</Text> : undefined
          }))}
        </Section>
      )}

      {stories.length > 0 && (
        <Section id="dash:stories" label="Stories" count={stories.length} icon={IconListDetails} accent="cockpit">
          {body('stories', stories, ({ r: st, id }) => row({
            k: id, dot: st.dot, Icon: IconListDetails, text: st.item, repo: st.repo, actions: st.actions,
            details: [['Status', st.status], ['Plan', st.phase ? PHASE[st.phase].label : null], ['Next', st.next]],
            sub: <StorySub st={st} repo={repoFor(st.repo)} repos={repos} />
          }))}
        </Section>
      )}

      {myPrs.length > 0 && (
        <Section id="dash:my prs" label="My PRs" count={myPrs.length} icon={IconGitPullRequest} accent="cockpit">
          {body('myPrs', myPrs, ({ r: p, id }) => row({
            k: id, dot: p.dot, Icon: IconGitPullRequest, text: p.item, repo: p.repo, actions: p.actions, ghNum: p.number ?? hashOf(p.item),
            right: <ChecksIcon checks={p.checks} />,
            details: [['State', p.state], ['Checks', p.checks ? CHECKS[p.checks].label : null], ['Next', p.next]],
            sub: filled(p.state) || filled(p.next) ? <Text size="xs" c="dimmed" lh={1.4}>{[p.state, p.next].filter(filled).join(' · ')}</Text> : undefined
          }))}
        </Section>
      )}

      {qa.length > 0 && (
        <Section id="dash:qa" label="QA" count={qa.length} icon={IconTestPipe} accent="yellow">
          {body('qa', qa, ({ r: q, n, id }) => row({
            k: id, dot: q.dot, Icon: IconTestPipe, text: q.item, repo: q.repo,
            actions: q.actions ?? [{ label: 'Test', run: `qa ${q.key || q.item.match(/^\s*([A-Z][A-Z0-9]*-\d+)/)?.[1] || n + 1}` }],
            details: [['Priority', q.priority]],
            sub: filled(q.priority) ? <Badge size="xs" variant="light" color={/highest|high/i.test(q.priority) ? 'red' : 'gray'}>{q.priority}</Badge> : undefined
          }))}
        </Section>
      )}

      {reviews.length > 0 && (
        <Section id="dash:reviews" label="Reviews" count={reviews.length} icon={IconFileSearch} accent="gray">
          {body('reviews', reviews, ({ r, id }) => row({
            k: id, dot: r.dot, Icon: IconFileSearch, text: r.item, repo: r.repo, actions: r.actions, ghNum: r.number ?? hashOf(r.item),
            right: <ChecksIcon checks={r.checks} />,
            details: [['Author', r.author], ['State', r.state], ['Checks', r.checks ? CHECKS[r.checks].label : null], ['Next', r.next]],
            sub: (r.author || filled(r.state) || filled(r.next))
              ? <Text size="xs" c="dimmed" lh={1.4}>{[r.author ? `by ${r.author}` : '', r.state, r.next].filter(filled).join(' · ')}</Text>
              : undefined
          }))}
        </Section>
      )}

      {inFlight.length ? (
        <Section id="dash:in flight" label="In flight" count={inFlight.length} icon={IconLoader2} accent="yellow">
          {inFlight.map((f, i) => (
            <Group key={i} gap={9} wrap="nowrap" px="md" py={6}>
              <Box w={7} h={7} style={{ borderRadius: '50%', background: DOT_VAR.yellow, flex: 'none' }} />
              <Text size="xs" c="dimmed" truncate>{f.repo ? `${f.repo} · ` : ''}{f.text}</Text>
            </Group>
          ))}
        </Section>
      ) : null}

      {s && !anything && (
        <Group gap={9} px="md" py="sm">
          <Box style={{ color: DOT_VAR.green, display: 'flex', flex: 'none' }}><IconCircleCheck size={17} stroke={2} /></Box>
          <Text size="sm" c="dimmed">{s.quiet || 'All clear — nothing needs you.'}</Text>
        </Group>
      )}

      <PrModal
        repoId={prModal?.repoId ?? null}
        number={prModal?.number ?? null}
        title={prModal?.title}
        onClose={() => setPrModal(null)}
      />
    </Stack>
  )
}

function StorySub({ st, repo, repos }: { st: Story; repo?: RepoCfg; repos: RepoCfg[] }) {
  const ph = st.phase ? PHASE[st.phase] : null
  if (!ph && !filled(st.status) && !filled(st.next)) return null
  return (
    <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
      {filled(st.status) ? <Badge size="xs" variant="light" color="gray" style={{ flex: 'none' }}>{st.status}</Badge> : null}
      {ph ? <Badge size="xs" variant="light" color={ph.color} style={{ flex: 'none' }}>{ph.label}</Badge> : null}
      {filled(st.next) ? <Text size="xs" c="dimmed" lh={1.4} truncate><Linked text={st.next} repo={repo} repos={repos} /></Text> : null}
    </Group>
  )
}

function ChecksIcon({ checks }: { checks?: Checks }) {
  if (!checks) return null
  const c = CHECKS[checks]
  return (
    <Tooltip label={c.label} openDelay={350} withArrow position="left">
      <Box style={{ color: c.color, display: 'flex' }}><c.icon size={16} stroke={2} /></Box>
    </Tooltip>
  )
}

// Per-row actions: everything — Approve / Resolve / Test / … plus "Open PR on
// GitHub" — lives in the ⋮ menu; no standalone buttons. A ✓ flashes when one fires.
function Actions({ actions, repo, ghNum, sent, fire }: {
  actions?: SurfaceAction[]; repo?: RepoCfg; ghNum?: string | number
  sent: string | null; fire: (a: SurfaceAction) => void
}) {
  const list = actions ?? []
  const ghHref = ghNum != null && repo ? `https://github.com/${repo.slug}/pull/${String(ghNum).replace(/^#/, '')}` : null
  if (!list.length && !ghHref) return null
  const flashing = list.some((a) => a.run === sent)

  return (
    <Menu shadow="md" width={230} position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon variant="subtle" color={flashing ? 'teal' : 'gray'} size="sm" aria-label="Actions">
          {flashing ? <Text size="sm" c="teal" lh={1}>✓</Text> : <span style={{ fontSize: 16, lineHeight: 1 }}>⋮</span>}
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {list.length ? <Menu.Label>Actions</Menu.Label> : null}
        {list.map((a, i) => a.href ? (
          <Menu.Item key={i} component="a" href={a.href} target="_blank" rel="noreferrer" leftSection={<IconExternalLink size={14} />}>
            <Text size="sm">{a.label}</Text>
          </Menu.Item>
        ) : (
          <Menu.Item key={i} onClick={() => fire(a)}>
            <Group gap={8} justify="space-between" wrap="nowrap">
              <Text size="sm">{a.label}</Text>
              <Text size="xs" c="dimmed" ff="monospace">{a.run}</Text>
            </Group>
          </Menu.Item>
        ))}
        {ghHref && list.length ? <Menu.Divider /> : null}
        {ghHref ? (
          <Menu.Item leftSection={<IconExternalLink size={14} />} component="a" href={ghHref} target="_blank" rel="noreferrer">Open PR on GitHub</Menu.Item>
        ) : null}
      </Menu.Dropdown>
    </Menu>
  )
}

// Turn ABC-1234 into a Jira link and #123 into a GitHub PR link, in place. A bare #123
// is a PR in the row's repo; `api#123` or `acme/api#123` is one in that repo, so
// a ticket spanning repos links each PR to its own.
function Linked({ text, repo, repos }: { text: string; repo?: RepoCfg; repos: RepoCfg[] }) {
  const key = repo?.jiraKey && repo.jiraBase ? repo.jiraKey : null
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = [key ? `${esc(key)}-\\d+` : '', '(?:[\\w.-]+/)?[\\w.-]+#\\d+', '#\\d+'].filter(Boolean).join('|')
  const parts = text.split(new RegExp(`(${pattern})`, 'g'))
  const pr = (i: number, slug: string, label: string, n: string) =>
    <a key={i} className="ck-link" href={`https://github.com/${slug}/pull/${n}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{label}</a>
  return (
    <>
      {parts.map((p, i) => {
        if (key && new RegExp(`^${esc(key)}-\\d+$`).test(p)) {
          return <a key={i} className="ck-link" href={`${repo!.jiraBase}/${p}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{p}</a>
        }
        const q = p.match(/^(?:([\w.-]+)\/)?([\w.-]+)#(\d+)$/)
        if (q) {
          // owner/name → that GitHub repo as written; a bare name → a configured repo by id or name.
          const slug = q[1] ? `${q[1]}/${q[2]}` : repos.find((r) => r.id === q[2] || r.slug.split('/').pop() === q[2])?.slug
          if (slug) return pr(i, slug, p, q[3])
          // Not a repo (e.g. "PR#12"): the prefix is text, the #n is the row's.
          const at = p.lastIndexOf('#')
          return <span key={i}>{p.slice(0, at)}{repo ? pr(i, repo.slug, p.slice(at), q[3]) : p.slice(at)}</span>
        }
        if (/^#\d+$/.test(p) && repo) return pr(i, repo.slug, p, p.slice(1))
        return <span key={i}>{p}</span>
      })}
    </>
  )
}

function Muted({ children }: { children: React.ReactNode }) {
  return <Text size="xs" c="dimmed">{children}</Text>
}
