import { useEffect, useState } from 'react'
import { Badge, Box, Button, Group, Loader, Modal, Stack, Text } from '@mantine/core'
import { IconAlertTriangle, IconArrowLeft, IconCircleCheck, IconCircleCheckFilled, IconCircleDashed, IconCircleXFilled, IconExternalLink, IconFileText, IconGitMerge, IconGitPullRequest, IconGitPullRequestClosed, IconGitPullRequestDraft, IconLoader2, IconMessage, IconUsers } from '@tabler/icons-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getPrView } from './api'
import { Section } from './Section'
import type { Checks, PrView } from './types'

export const CHECK: Record<Checks, { icon: typeof IconCircleCheck; color: string; label: string }> = {
  pass: { icon: IconCircleCheck, color: 'var(--mantine-color-teal-5)', label: 'Checks passing' },
  fail: { icon: IconAlertTriangle, color: 'var(--mantine-color-red-6)', label: 'Checks failing' },
  pending: { icon: IconLoader2, color: 'var(--ck-yellow)', label: 'Checks running' }
}

// PR state + review decision → one status: a label, a Mantine colour for its badge,
// and the pull-request icon that goes with the state.
type PrLike = { state?: string; isDraft?: boolean; reviewDecision?: string | null }
export function prBadge(pr: PrLike): { label: string; color: string; icon: typeof IconGitPullRequest } {
  if (pr.state === 'MERGED') return { label: 'Merged', color: 'grape', icon: IconGitMerge }
  if (pr.state === 'CLOSED') return { label: 'Closed', color: 'gray', icon: IconGitPullRequestClosed }
  if (pr.isDraft) return { label: 'Draft', color: 'gray', icon: IconGitPullRequestDraft }
  switch (pr.reviewDecision) {
    case 'APPROVED': return { label: 'Approved', color: 'teal', icon: IconGitPullRequest }
    case 'CHANGES_REQUESTED': return { label: 'Changes requested', color: 'red', icon: IconGitPullRequest }
    case 'REVIEW_REQUIRED': return { label: 'Review required', color: 'yellow', icon: IconGitPullRequest }
    default: return { label: 'Open', color: 'cockpit', icon: IconGitPullRequest }
  }
}

// Links inside the description open in a new tab. (node is dropped so it isn't
// spread onto the DOM anchor.)
const MD = {
  a: (props: React.ComponentPropsWithoutRef<'a'> & { node?: unknown }) => {
    const { node: _node, ...rest } = props; void _node
    return <a {...rest} target="_blank" rel="noreferrer" />
  }
}

export function PrModal({ repoId, number, title, onClose }: { repoId: string | null; number: string | number | null; title?: string; onClose: () => void }) {
  const [pr, setPr] = useState<PrView | null>(null)
  const [loading, setLoading] = useState(false)
  const opened = repoId != null && number != null

  useEffect(() => {
    if (!opened) { setPr(null); return }
    let cancelled = false
    setLoading(true)
    getPrView(repoId!, number!)
      .then((d) => { if (!cancelled) setPr(d) })
      .catch((e) => { if (!cancelled) setPr({ error: e instanceof Error ? e.message : 'failed to load' }) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [repoId, number, opened])

  const shown = pr && !pr.error ? pr : null
  const badge = shown?.state ? prBadge(shown) : null
  const chk = shown?.checks ? CHECK[shown.checks] : null
  const num = number != null ? String(number).replace(/^#/, '') : null

  // The header (title plus one line of state, branches, checks and size) stays
  // pinned while the description scrolls beneath it.
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size="min(1000px, 90vw)"
      title={
        <Stack gap={10}>
          <Group gap={10} wrap="nowrap" align="flex-start">
            {badge ? <Box style={{ color: `var(--mantine-color-${badge.color}-5)`, display: 'flex', flex: 'none', paddingTop: 3 }}><badge.icon size={20} stroke={2} /></Box> : null}
            <Text size="lg" fw={700} lh={1.3}>
              {num ? <Text span inherit c="dimmed" fw={500} className="ck-num">#{num} </Text> : null}
              {shown?.title || title || 'Pull request'}
            </Text>
          </Group>
          {shown ? (
            <Group gap={14} wrap="wrap" align="center">
              {badge ? <Badge size="sm" variant="light" color={badge.color}>{badge.label}</Badge> : null}
              {shown.head && shown.base ? (
                <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                  <Text size="xs" c="dimmed" style={{ flex: 'none' }}>{shown.author ? `${shown.author} ·` : ''}</Text>
                  <Text size="xs" ff="monospace" className="ck-chip">{shown.base}</Text>
                  <IconArrowLeft size={12} style={{ flex: 'none', color: 'var(--mantine-color-dimmed)' }} />
                  <Text size="xs" ff="monospace" className="ck-chip" truncate>{shown.head}</Text>
                </Group>
              ) : shown.author ? <Text size="xs" c="dimmed">by {shown.author}</Text> : null}
              {chk ? (
                <Group gap={4} wrap="nowrap" style={{ color: chk.color }}>
                  <chk.icon size={14} stroke={2} />
                  <Text size="xs" style={{ color: 'inherit' }}>{chk.label}</Text>
                </Group>
              ) : null}
              {typeof shown.additions === 'number' ? (
                <Text size="xs" className="ck-num">
                  <Text span inherit c="teal">+{shown.additions.toLocaleString()}</Text>{' '}
                  <Text span inherit c="red">−{(shown.deletions ?? 0).toLocaleString()}</Text>
                  {typeof shown.changedFiles === 'number' ? <Text span inherit c="dimmed"> · {shown.changedFiles} file{shown.changedFiles === 1 ? '' : 's'}</Text> : null}
                </Text>
              ) : null}
              {shown.url ? (
                <Button component="a" href={shown.url} target="_blank" rel="noreferrer" size="compact-xs" variant="light" color="gray" ml="auto"
                  rightSection={<IconExternalLink size={12} />}>Open on GitHub</Button>
              ) : null}
            </Group>
          ) : null}
        </Stack>
      }
      styles={{
        header: { alignItems: 'flex-start', borderBottom: '1px solid var(--ck-divider)', paddingBottom: 14 },
        title: { flex: 1, minWidth: 0 },
        body: { paddingTop: 16 }
      }}
    >
      {loading && !pr && <Group justify="center" py="xl"><Loader size="sm" /></Group>}
      {pr?.error && <Text size="sm" c="red">{pr.error}</Text>}
      {shown && (shown.body
        ? <Box className="ck-md"><ReactMarkdown remarkPlugins={[remarkGfm]} components={MD}>{shown.body}</ReactMarkdown></Box>
        : <Text size="sm" c="dimmed" fs="italic">No description.</Text>)}
    </Modal>
  )
}

const REVIEW: Record<string, { label: string; color: string; icon: typeof IconCircleCheck }> = {
  APPROVED: { label: 'Approved', color: 'var(--mantine-color-teal-5)', icon: IconCircleCheck },
  CHANGES_REQUESTED: { label: 'Changes requested', color: 'var(--mantine-color-red-6)', icon: IconAlertTriangle },
  COMMENTED: { label: 'Commented', color: 'var(--mantine-color-dimmed)', icon: IconMessage },
  DISMISSED: { label: 'Dismissed', color: 'var(--mantine-color-dimmed)', icon: IconCircleDashed },
  PENDING: { label: 'Pending', color: 'var(--ck-yellow)', icon: IconCircleDashed }
}
// One check run in the PR tab's list: a filled tick / cross, or a spinner while it runs.
const RUN: Record<Checks, { icon: typeof IconCircleCheck; color: string; label: string; spin?: boolean }> = {
  pass: { icon: IconCircleCheckFilled, color: 'var(--mantine-color-teal-5)', label: 'Passed' },
  fail: { icon: IconCircleXFilled, color: 'var(--mantine-color-red-6)', label: 'Failed' },
  pending: { icon: IconLoader2, color: 'var(--ck-yellow)', label: 'Running', spin: true }
}
const CHECK_ORDER: Record<Checks, number> = { fail: 0, pending: 1, pass: 2 }
const CHECK_ACCENT: Record<Checks, string> = { fail: 'red', pending: 'yellow', pass: 'teal' }

// The space panel's PR tab: the PR's title, then its state, author, branches, size
// and checks as labelled fields, then every check run and the latest reviews as
// foldable lists. The description is too long for the panel; Description opens the
// full modal. Refetched when the panel's polled state or checks change.
export function PrPane({ repoId, number, state, checks }: { repoId: string; number: number; state?: string; checks?: Checks | null }) {
  const [pr, setPr] = useState<PrView | null>(null)
  const [full, setFull] = useState(false)

  useEffect(() => {
    let cancelled = false
    getPrView(repoId, number)
      .then((d) => { if (!cancelled) setPr(d) })
      .catch((e) => { if (!cancelled) setPr({ error: e instanceof Error ? e.message : 'failed to load' }) })
    return () => { cancelled = true }
  }, [repoId, number, state, checks])

  if (!pr) return <Group justify="center" py="lg"><Loader size="sm" /></Group>
  if (pr.error) return <Box px="md" py="sm"><Text size="xs" c="red">{pr.error}</Text></Box>
  const badge = prBadge(pr)
  const runs = [...(pr.checkRuns ?? [])].sort((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state] || a.name.localeCompare(b.name))
  const reviews = pr.reviews ?? []
  const tally = (st: Checks) => runs.filter((r) => r.state === st).length
  const chk = pr.checks ? CHECK[pr.checks] : null

  return (
    <>
      <Box px="md" pt={14} pb={14}>
        <Text size="sm" fw={600} lh={1.4}>
          <Text span inherit c="dimmed" className="ck-num" fw={500}>#{pr.number}</Text> {pr.title}
        </Text>
        <Stack gap={9} mt={12}>
          <Field label="Status">
            <Group gap={6} wrap="nowrap">
              <Box style={{ color: `var(--mantine-color-${badge.color}-5)`, display: 'flex' }}><badge.icon size={14} stroke={2} /></Box>
              <Badge size="sm" variant="light" color={badge.color}>{badge.label}</Badge>
            </Group>
          </Field>
          {pr.author ? <Field label="Author"><Text size="xs">{pr.author}</Text></Field> : null}
          {pr.head && pr.base ? (
            <Field label="Branches">
              <Group gap={5} wrap="nowrap" style={{ minWidth: 0 }}>
                <Text size="xs" ff="monospace" className="ck-chip" style={{ flex: 'none' }}>{pr.base}</Text>
                <IconArrowLeft size={12} style={{ flex: 'none', color: 'var(--mantine-color-dimmed)' }} />
                <Text size="xs" ff="monospace" className="ck-chip" truncate title={pr.head}>{pr.head}</Text>
              </Group>
            </Field>
          ) : null}
          {typeof pr.additions === 'number' ? (
            <Field label="Size">
              <Text size="xs" className="ck-num">
                <Text span inherit c="teal">+{pr.additions.toLocaleString()}</Text>{' '}
                <Text span inherit c="red">−{(pr.deletions ?? 0).toLocaleString()}</Text>
                {typeof pr.changedFiles === 'number' ? <Text span inherit c="dimmed"> · {pr.changedFiles} file{pr.changedFiles === 1 ? '' : 's'}</Text> : null}
              </Text>
            </Field>
          ) : null}
          {chk ? (
            <Field label="Checks">
              <Group gap={5} wrap="nowrap" style={{ color: chk.color }}>
                <chk.icon size={14} stroke={2} />
                <Text size="xs" style={{ color: 'inherit' }}>
                  {runs.length ? [tally('fail') && `${tally('fail')} failed`, tally('pending') && `${tally('pending')} running`, tally('pass') && `${tally('pass')} passed`].filter(Boolean).join(' · ') : chk.label}
                </Text>
              </Group>
            </Field>
          ) : null}
        </Stack>
        <Group gap={8} mt={14} grow>
          <Button size="compact-sm" variant="light" color="gray" leftSection={<IconFileText size={14} />} onClick={() => setFull(true)}>Description</Button>
          {pr.url ? (
            <Button component="a" href={pr.url} target="_blank" rel="noreferrer" size="compact-sm" variant="light" color="gray" rightSection={<IconExternalLink size={13} />}>GitHub</Button>
          ) : null}
        </Group>
      </Box>

      {runs.length ? (
        <Section id="pr:checks" label="Checks" icon={pr.checks ? CHECK[pr.checks].icon : IconCircleCheck} accent={pr.checks ? CHECK_ACCENT[pr.checks] : 'gray'} count={runs.length}>
          {runs.map((c, i) => {
            const k = RUN[c.state]
            const line = (
              <Group gap={9} wrap="nowrap" px="md" py={6}>
                <Box style={{ color: k.color, display: 'flex', flex: 'none' }}><k.icon size={15} stroke={2} className={k.spin ? 'ck-spin' : undefined} /></Box>
                <Text size="xs" truncate style={{ flex: 1, minWidth: 0 }} title={c.name}>{c.name}</Text>
                <Text size="xs" style={{ color: k.color, flex: 'none' }}>{k.label}</Text>
              </Group>
            )
            return c.url
              ? <Box key={i} component="a" href={c.url} target="_blank" rel="noreferrer" className="ck-row" style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}>{line}</Box>
              : <Box key={i}>{line}</Box>
          })}
        </Section>
      ) : null}

      {reviews.length ? (
        <Section id="pr:reviews" label="Reviews" icon={IconUsers} accent="gray" count={reviews.length}>
          {reviews.map((r, i) => {
            const k = REVIEW[r.state] ?? { label: r.state.toLowerCase(), color: 'var(--mantine-color-dimmed)', icon: IconMessage }
            return (
              <Group key={i} gap={9} wrap="nowrap" px="md" py={6}>
                <Box style={{ color: k.color, display: 'flex', flex: 'none' }}><k.icon size={15} stroke={2} /></Box>
                <Text size="xs" fw={500} truncate style={{ flex: 1, minWidth: 0 }}>{r.author}</Text>
                <Text size="xs" style={{ color: k.color, flex: 'none' }}>{k.label}</Text>
              </Group>
            )
          })}
        </Section>
      ) : null}

      <PrModal repoId={full ? repoId : null} number={full ? number : null} title={pr.title} onClose={() => setFull(false)} />
    </>
  )
}

// A labelled field in the PR tab: a fixed label column, the value beside it.
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Group gap={10} wrap="nowrap" align="center">
      <Text size="xs" c="dimmed" w={62} style={{ flex: 'none' }}>{label}</Text>
      <Box style={{ flex: 1, minWidth: 0 }}>{children}</Box>
    </Group>
  )
}
