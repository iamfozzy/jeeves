import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ActionIcon, Alert, Badge, Box, Button, Code, Group, Input, Modal, MultiSelect, NumberInput, SegmentedControl, Select,
  SimpleGrid, Stack, Table, Tabs, TagsInput, Text, TextInput, Textarea, Tooltip, UnstyledButton
} from '@mantine/core'
import {
  IconAlertTriangle, IconArrowBackUp, IconBell, IconCheck, IconChevronRight, IconCopy, IconDeviceFloppy,
  IconFolderCog, IconKey, IconPencil, IconPlus, IconRepeat, IconRobot, IconSearch, IconServer, IconShieldCheck, IconStack2, IconTrash, IconTypography, IconWand, IconX
} from '@tabler/icons-react'
import { editAgent, editReminder, getAgents, getConfigView, getGuardLog, getReminders, getSettings, getStatusLine, installStatusLine, openPromptTab, saveConfig, saveSettings, type GuardRow, type StatusLineView } from './api'
import { setToken } from './token'
import { FONT_NAME, fontStack, previewFont, type FontKind } from './theme'
import type {
  AgentDef, AgentOp, AgentsView, BuiltinAgent, CockpitKey, CockpitView, ConfigView, ConfigWrite,
  ProjectFields, ProjectView, Reminder, ReminderOp, SettingsView
} from './types'

type Val = string | string[]
type Write = (w: ConfigWrite) => Promise<string | null> // resolves to an error message, or null
// list = free tags; multi = a pick from fixed options; range = a whole number
// within bounds; font = a Google Font picker with a live preview.
type FieldSpec = {
  key: string; label: string; hint?: string; list?: boolean; multi?: string[]; choices?: string[]; select?: string[]; placeholder?: string
  range?: [number, number]; font?: FontKind
}

// Spacing scale for the whole modal: 8 within a control group, 12 between a
// heading and its content, 16 between fields, 28 between sections.
const GAP = { tight: 8, head: 12, field: 16, section: 28 }

// Blank text or an empty list means "not set".
const norm = (v: Val | null | undefined): Val | null => {
  if (v == null) return null
  if (Array.isArray(v)) { const a = v.map((s) => s.trim()).filter(Boolean); return a.length ? a : null }
  return v.trim() || null
}
const same = (a: Val | null | undefined, b: Val | null | undefined) => JSON.stringify(norm(a)) === JSON.stringify(norm(b))
const blank = (s: FieldSpec): Val => (s.list ? [] : '')

export function Settings({ opened, onClose, configNonce, onPromptTab }: {
  opened: boolean
  onClose: () => void
  configNonce: number                   // bumps when config changes server-side → refetch
  onPromptTab: (tabId: string) => void  // add that claude tab to the Scratchpad, show it, close Settings
}) {
  const [view, setView] = useState<ConfigView | null>(null)
  const [s, setS] = useState<SettingsView | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)

  useEffect(() => {
    if (!opened) return
    let live = true
    Promise.all([getConfigView(), getSettings()])
      .then(([v, x]) => { if (live) { setView(v); setS(x); setLoadErr(null) } })
      .catch(() => { if (live) setLoadErr('could not load settings') })
    return () => { live = false }
  }, [opened, configNonce])

  const write: Write = async (w) => {
    const r = await saveConfig(w).catch((e): { error: string } => ({ error: String(e) }))
    if ('error' in r) return r.error
    setView(r)
    return null
  }

  const loading = loadErr ? <Alert color="red" variant="light" p="xs">{loadErr}</Alert> : <Text size="sm" c="dimmed">Loading…</Text>

  const both = view && s ? { view, s } : null

  // Vertical tabs on the app's page tone (like the sidebar), grouped by what they
  // configure; each pane scrolls on its own, so a pane's sticky save bar stays in view.
  return (
    <Modal opened={opened} onClose={onClose} title="Settings" size="min(1160px, 94vw)" centered padding={0} className="ck-settings"
      styles={{
        content: { height: '90dvh', display: 'flex', flexDirection: 'column' },
        header: { padding: '14px 20px', borderBottom: '1px solid var(--ck-border)', margin: 0 },
        title: { fontWeight: 600 },
        body: { padding: 0, flex: 1, minHeight: 0 }
      }}>
      <Tabs defaultValue="projects" orientation="vertical" variant="pills" keepMounted={false}
        styles={{
          root: { height: '100%' },
          list: { width: 184, flex: 'none', padding: 10, gap: 2, background: 'var(--ck-page)', borderRight: '1px solid var(--ck-border)' },
          panel: { flex: 1, minWidth: 0, height: '100%' }
        }}>
        <Tabs.List>
          <Text className="ck-label ck-sgroup">Work</Text>
          <Tabs.Tab className="ck-stab" value="projects" leftSection={<IconFolderCog size={16} />}>Projects</Tabs.Tab>
          <Tabs.Tab className="ck-stab" value="defaults" leftSection={<IconStack2 size={16} />}>Defaults</Tabs.Tab>
          <Tabs.Tab className="ck-stab" value="agents" leftSection={<IconRobot size={16} />}>Agents</Tabs.Tab>
          <Text className="ck-label ck-sgroup">Jeeves</Text>
          <Tabs.Tab className="ck-stab" value="loop" leftSection={<IconRepeat size={16} />}>Loop</Tabs.Tab>
          <Tabs.Tab className="ck-stab" value="rules" leftSection={<IconShieldCheck size={16} />}>Rules</Tabs.Tab>
          <Tabs.Tab className="ck-stab" value="reminders" leftSection={<IconBell size={16} />}>Reminders</Tabs.Tab>
          <Text className="ck-label ck-sgroup">Cockpit</Text>
          <Tabs.Tab className="ck-stab" value="cockpit" leftSection={<IconServer size={16} />}>Sessions & access</Tabs.Tab>
          <Tabs.Tab className="ck-stab" value="appearance" leftSection={<IconTypography size={16} />}>Appearance</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="projects">
          <Pane>{view ? <ProjectsTab projects={view.projects} write={write} onPromptTab={onPromptTab} /> : loading}</Pane>
        </Tabs.Panel>
        <Tabs.Panel value="defaults">
          <Pane>{view ? <DefaultsTab view={view} write={write} /> : loading}</Pane>
        </Tabs.Panel>
        <Tabs.Panel value="agents"><Pane><AgentsTab /></Pane></Tabs.Panel>
        <Tabs.Panel value="loop"><Pane>{both ? <LoopTab {...both} write={write} onSaved={setS} /> : loading}</Pane></Tabs.Panel>
        <Tabs.Panel value="rules"><Pane>{s ? <RulesTab s={s} onSaved={setS} /> : loading}</Pane></Tabs.Panel>
        <Tabs.Panel value="reminders"><Pane><RemindersSection /></Pane></Tabs.Panel>
        <Tabs.Panel value="cockpit"><Pane>{s ? <CockpitTab s={s} onSaved={setS} /> : loading}</Pane></Tabs.Panel>
        <Tabs.Panel value="appearance"><Pane>{s ? <AppearanceTab s={s} onSaved={setS} /> : loading}</Pane></Tabs.Panel>
      </Tabs>
    </Modal>
  )
}

const Pane = ({ children }: { children: ReactNode }) => (
  <Box style={{ height: '100%', overflowY: 'auto', scrollbarGutter: 'stable' }} px={24} pt={20} pb={24}>{children}</Box>
)

// One settings section: an optional title (a sub-tab's label stands in for it), an
// optional one-line description, the file it writes, an optional control on the
// right, then its content.
function Section({ title, description, file, right, children }: {
  title?: string; description?: ReactNode; file?: string; right?: ReactNode; children: ReactNode
}) {
  return (
    <Box>
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md" mb={GAP.head}>
        <Box style={{ minWidth: 0 }}>
          {title ? <Text size="sm" fw={600}>{title}</Text> : null}
          {description ? <Text size="xs" c="dimmed" mt={title ? 2 : 0}>{description}</Text> : null}
        </Box>
        {file || right ? (
          <Group gap={GAP.tight} wrap="nowrap" style={{ flex: 'none' }}>
            {file ? <Text size="xs" c="dimmed" ff="monospace">{file}</Text> : null}
            {right}
          </Group>
        ) : null}
      </Group>
      {children}
    </Box>
  )
}

// Tab-level lead-in: what the tab edits and when a change takes effect.
const Intro = ({ children }: { children: ReactNode }) => <Text size="sm" c="dimmed">{children}</Text>

// Tabs across the top of a pane, one section each. Every panel stays mounted, so a
// draft survives switching away, and a tab whose save bar has unsaved changes shows a dot.
const DirtyCtx = createContext<((dirty: boolean) => void) | null>(null)
function SubTabs({ tabs }: { tabs: { value: string; label: string; content: ReactNode }[] }) {
  const [dirty, setDirty] = useState<Record<string, boolean>>({})
  const report = useRef<Record<string, (d: boolean) => void>>({})
  const reporter = (v: string) => (report.current[v] ??= (d) => setDirty((x) => (!!x[v] === d ? x : { ...x, [v]: d })))
  return (
    <Tabs defaultValue={tabs[0].value}>
      <Tabs.List mb={GAP.section - 8}>
        {tabs.map((t) => (
          <Tabs.Tab key={t.value} value={t.value} rightSection={dirty[t.value] ? <Box className="ck-dirty" aria-label="unsaved changes" /> : null}>
            {t.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {tabs.map((t) => (
        <Tabs.Panel key={t.value} value={t.value}>
          <DirtyCtx.Provider value={reporter(t.value)}>{t.content}</DirtyCtx.Provider>
        </Tabs.Panel>
      ))}
    </Tabs>
  )
}

// ── Projects ─────────────────────────────────────────────────────────────────

const PROJECT_FIELDS: (FieldSpec & { key: keyof ProjectFields; unsetText?: string })[] = [
  { key: 'baseBranch', label: 'Base branch', hint: 'Merge target and diff base.', unsetText: "origin's default branch" },
  { key: 'jiraKey', label: 'Jira project key', hint: 'Matches ticket keys like ABC-1234.', unsetText: 'none' },
  { key: 'reviewScope', label: 'Review scope', choices: ['mine', 'repo'], hint: 'repo = also every open teammate PR.' },
  { key: 'reviewCommand', label: 'Review command', hint: 'Run when you review a PR in this repo.' },
  { key: 'seedFiles', label: 'Seed files', list: true, hint: 'Copied into every new worktree. Enter to add.' }
]

const overrideCount = (p: ProjectView) =>
  PROJECT_FIELDS.filter((s) => p.fields[s.key].source === 'project').length + p.otherOverrides.length

// A tab id the server accepts for a prompted tab (/^[a-z0-9]{4,16}$/).
const tabId = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('')

function ProjectsTab({ projects, write, onPromptTab }: { projects: ProjectView[]; write: Write; onPromptTab: (tabId: string) => void }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [adding, setAdding] = useState<string | null>(null) // the prompt being launched
  const [addErr, setAddErr] = useState<string | null>(null)

  const needle = q.trim().toLowerCase()
  const shown = [...projects]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .filter((p) => !needle || [p.slug, p.id, p.fields.jiraKey.value, p.fields.baseBranch.value].join(' ').toLowerCase().includes(needle))

  // Onboarding runs in its own claude tab in the Scratchpad, never in the orchestrator.
  const setup = async (prompt: string) => {
    setAdding(prompt); setAddErr(null)
    const id = tabId()
    const r = await openPromptTab(id, prompt).catch((e) => ({ error: String(e) }))
    setAdding(null)
    if (r.error) { setAddErr(r.error); return }
    onPromptTab(id)
  }

  return (
    <Section
      title="Projects"
      description="Each project inherits Defaults; open one to see and change what it overrides."
      right={(
        <Group gap="xs" wrap="nowrap" style={{ flex: 'none' }}>
          <Tooltip label="Runs /jeeves:setup in a new Claude tab in the Scratchpad" openDelay={300} withArrow>
            <Button size="xs" variant="subtle" leftSection={<IconWand size={14} />} loading={adding === '/jeeves:setup'} disabled={!!adding} onClick={() => setup('/jeeves:setup')}>Set up Jeeves</Button>
          </Tooltip>
          <Tooltip label="Runs /jeeves:setup --scan in a new Claude tab in the Scratchpad" openDelay={300} withArrow>
            <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} loading={adding === '/jeeves:setup --scan'} disabled={!!adding} onClick={() => setup('/jeeves:setup --scan')}>Add repos…</Button>
          </Tooltip>
        </Group>
      )}>
      <Stack gap={GAP.tight}>
        <TextInput placeholder={`Filter ${projects.length} project${projects.length === 1 ? '' : 's'}…`}
          leftSection={<IconSearch size={15} />} value={q} onChange={(e) => setQ(e.currentTarget.value)} />
        {addErr ? <Alert color="red" variant="light" p="xs">Couldn't start setup: {addErr}</Alert> : null}
        {projects.length === 0 ? <Text size="sm" c="dimmed">No projects configured.</Text>
          : shown.length === 0 ? <Text size="sm" c="dimmed">No project matches “{q}”.</Text>
          : (
            <Stack gap={2}>
              {shown.map((p) => {
                const expanded = open === p.id
                const n = overrideCount(p)
                return (
                  <ExpandRow key={p.id} open={expanded} onToggle={() => setOpen(expanded ? null : p.id)} head={<>
                    <Text size="sm" fw={600} style={{ flex: 'none' }}>{p.slug}</Text>
                    <Text size="xs" c="dimmed" truncate>
                      {[p.fields.baseBranch.value ?? 'origin default', p.fields.jiraKey.value ?? 'no key', n ? `${n} override${n === 1 ? '' : 's'}` : 'all defaults'].join(' · ')}
                    </Text>
                  </>}>
                    <ProjectPanel key={p.id} p={p} write={write} />
                  </ExpandRow>
                )
              })}
            </Stack>
          )}
      </Stack>
    </Section>
  )
}

// One project's effective config. A field shows its project.md value ("set here",
// resettable) or the inherited defaults.md value ("default", dimmed). Saving writes
// only real overrides: a value equal to the default is sent as a reset.
function ProjectPanel({ p, write }: { p: ProjectView; write: Write }) {
  const [draft, setDraft] = useState<Partial<Record<keyof ProjectFields, Val>>>({})
  const ui = (s: typeof PROJECT_FIELDS[number]): Val => draft[s.key] ?? p.fields[s.key].value ?? blank(s)
  const ownBefore = (k: keyof ProjectFields) => (p.fields[k].source === 'project' ? p.fields[k].value : null)
  const ownAfter = (s: typeof PROJECT_FIELDS[number]) => {
    const v = norm(ui(s))
    return v == null || same(v, p.fields[s.key].default) ? null : v
  }
  const changed = PROJECT_FIELDS.filter((s) => s.key in draft && !same(ownAfter(s), ownBefore(s.key)))

  const save = async () => {
    const set: Record<string, Val> = {}, unset: string[] = []
    for (const s of changed) { const v = ownAfter(s); if (v == null) unset.push(s.key); else set[s.key] = v }
    const e = await write({ file: 'project', project: p.id, set, unset })
    if (!e) setDraft({})
    return e
  }

  return (
    <Stack gap={GAP.field + 4}>
      <SimpleGrid cols={2} spacing={GAP.field} verticalSpacing={4}>
        <KV k="Repo" v={p.repo.value ?? p.id} />
        <KV k="Path" v={p.path.value ?? '—'} note={p.path.source === 'default' ? 'dev root + repo name' : undefined} />
      </SimpleGrid>
      <SimpleGrid cols={2} spacing={GAP.field} verticalSpacing={GAP.field}>
        {PROJECT_FIELDS.map((s) => {
          const f = p.fields[s.key]
          const set = s.key in draft ? ownAfter(s) != null : f.source === 'project'
          const tag = set ? 'set' : f.default != null ? 'default' : 'unset'
          return (
            <FieldInput key={s.key} spec={s} value={ui(s)} dimmed={!set}
              placeholder={f.default == null ? s.unsetText : undefined}
              onChange={(v) => setDraft((d) => ({ ...d, [s.key]: v }))}
              tag={<SourceTag tag={tag} onReset={() => setDraft((d) => ({ ...d, [s.key]: f.default ?? blank(s) }))} />} />
          )
        })}
      </SimpleGrid>
      {p.otherOverrides.length ? (
        <Text size="xs" c="dimmed">Also overrides in project.md: {p.otherOverrides.join(', ')} — edit the file to change these.</Text>
      ) : null}
      <SaveBar dirty={changed.length > 0} onSave={save} onDiscard={() => setDraft({})} />
    </Stack>
  )
}

function SourceTag({ tag, onReset }: { tag: 'set' | 'default' | 'unset'; onReset: () => void }) {
  if (tag === 'set') return (
    <Group gap={2} wrap="nowrap">
      <Badge size="xs" variant="light" color="teal">set here</Badge>
      <Tooltip label="Reset to default" openDelay={300} withArrow>
        <ActionIcon size="xs" variant="subtle" color="gray" onClick={(e) => { e.preventDefault(); onReset() }} aria-label="Reset to default">
          <IconArrowBackUp size={12} />
        </ActionIcon>
      </Tooltip>
    </Group>
  )
  return <Badge size="xs" variant="transparent" color="gray">{tag}</Badge>
}

// ── Defaults + identity ─────────────────────────────────────────────────────

const DEFAULT_SECTIONS: { title: string; fields: FieldSpec[] }[] = [
  { title: 'Jira', fields: [
    { key: 'cloudId', label: 'Cloud ID', hint: 'Atlassian cloudId.' },
    { key: 'jiraSite', label: 'Site', hint: '<site>.atlassian.net — links ticket keys.' },
    { key: 'planTrigger', label: 'Plan trigger', hint: 'Status that surfaces plan <TICKET>.' },
    { key: 'qaAssigneeField', label: 'QA-assignee field', hint: 'Single-user picker, e.g. customfield_12345.' },
    { key: 'qaColumns', label: 'QA columns', list: true, hint: 'Statuses that count as "in QA".' }
  ] },
  { title: 'Confluence', fields: [
    { key: 'confluenceSpace', label: 'Space', hint: 'Where plan pages are published.' },
    { key: 'plansParent', label: 'Plans parent', hint: 'Plans nest under <parent> > <display name>.' }
  ] },
  { title: 'GitHub & worktrees', fields: [
    { key: 'reviewScope', label: 'Review scope', choices: ['mine', 'repo'], hint: 'repo = also every open teammate PR.' },
    { key: 'reviewCommand', label: 'Review command', placeholder: '/code-review', hint: 'Run when you review a PR.' },
    { key: 'baseBranches', label: 'Base branches', list: true, hint: 'setup --scan picks the first on origin.' },
    { key: 'seedFiles', label: 'Seed files', list: true, hint: 'Copied into every new worktree.' }
  ] }
]
const IDENTITY_FIELDS: FieldSpec[] = [
  { key: 'ghLogin', label: 'gh login' },
  { key: 'jiraEmail', label: 'Jira email' },
  { key: 'displayName', label: 'Display name', hint: 'Names your Confluence plans folder.' },
  { key: 'devRoot', label: 'Dev root', hint: 'A project path defaults to <dev root>/<repo>.' }
]

// Edits over a flat file's values: only touched fields are sent; blank = unset.
function useFlatForm(values: Record<string, Val | null>, specs: FieldSpec[]) {
  const [draft, setDraft] = useState<Record<string, Val>>({})
  const get = (s: FieldSpec): Val => draft[s.key] ?? values[s.key] ?? blank(s)
  const changed = specs.filter((s) => s.key in draft && !same(draft[s.key], values[s.key]))
  const payload = () => {
    const set: Record<string, Val> = {}, unset: string[] = []
    for (const s of changed) { const v = norm(draft[s.key]); if (v == null) unset.push(s.key); else set[s.key] = v }
    return { set, unset }
  }
  return { get, changed, payload, edit: (k: string, v: Val) => setDraft((d) => ({ ...d, [k]: v })), clear: () => setDraft({}) }
}

function DefaultsTab({ view, write }: { view: ConfigView; write: Write }) {
  return (
    <Stack gap={GAP.section}>
      <Intro>What every project inherits unless its own project.md overrides it, plus who you are. Blank a field to remove it.</Intro>
      {!view.defaults.exists ? <Alert color="blue" variant="light" p="xs">No defaults.md yet — saving creates it from the template.</Alert> : null}
      <SubTabs tabs={[
        ...DEFAULT_SECTIONS.map((sec) => ({
          value: sec.title, label: sec.title, content: <DefaultsForm view={view} write={write} sections={[{ specs: sec.fields }]} />
        })),
        { value: 'identity', label: 'Identity', content: <IdentitySection identity={view.identity} write={write} /> }
      ]} />
    </Stack>
  )
}

function IdentitySection({ identity, write }: { identity: ConfigView['identity']; write: Write }) {
  const [editing, setEditing] = useState(false)
  const f = useFlatForm(identity.values, IDENTITY_FIELDS)
  const save = async () => {
    const e = await write({ file: 'identity', ...f.payload() })
    if (!e) { f.clear(); setEditing(false) }
    return e
  }
  return (
    <Section description="Personal, never shared." file="identity.md"
      right={(
        <Button size="xs" variant="default" leftSection={editing ? <IconX size={14} /> : <IconPencil size={14} />}
          onClick={() => { f.clear(); setEditing(!editing) }} style={{ flex: 'none' }}>{editing ? 'Cancel' : 'Edit'}</Button>
      )}>
      {editing ? (
        <Stack gap={GAP.field}>
          {!identity.exists ? <Text size="xs" c="dimmed">No identity.md yet — saving creates it from the template.</Text> : null}
          <SimpleGrid cols={2} spacing={GAP.field} verticalSpacing={GAP.field}>
            {IDENTITY_FIELDS.map((s) => <FieldInput key={s.key} spec={s} value={f.get(s)} onChange={(v) => f.edit(s.key, v)} />)}
          </SimpleGrid>
          <SaveBar dirty={f.changed.length > 0} onSave={save} />
        </Stack>
      ) : (
        <SimpleGrid cols={2} spacing={GAP.field} verticalSpacing={6} p={12} style={{ background: 'var(--ck-page)', borderRadius: 8 }}>
          {IDENTITY_FIELDS.map((s) => <KV key={s.key} k={s.label} v={identity.values[s.key as keyof typeof identity.values] ?? '—'} />)}
        </SimpleGrid>
      )}
    </Section>
  )
}

// ── Shared bits ─────────────────────────────────────────────────────────────

// A row that expands in place: a chevron and `head`, then `children` while open.
function ExpandRow({ open, onToggle, head, children }: { open: boolean; onToggle: () => void; head: ReactNode; children: ReactNode }) {
  return (
    <Box style={{ borderRadius: 8, background: open ? 'var(--ck-page)' : undefined }}>
      <UnstyledButton onClick={onToggle} px={10} py={9} w="100%" className={open ? undefined : 'ck-row'} style={{ borderRadius: 8 }}>
        <Group gap={10} wrap="nowrap">
          <IconChevronRight size={14} style={{ flex: 'none', color: 'var(--mantine-color-dimmed)', transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms' }} />
          {head}
        </Group>
      </UnstyledButton>
      {open ? <Box px={16} pt={4} pb={16}>{children}</Box> : null}
    </Box>
  )
}

const ReadOnlyText = ({ text }: { text: string }) => (
  <Code block fz="xs" style={{ maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{text}</Code>
)
const MONO_TEXTAREA = { label: { marginBottom: 6 }, description: { marginBottom: 6 }, input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 13, lineHeight: 1.55, padding: 12 } }

function KV({ k, v, note }: { k: string; v: string; note?: string }) {
  return (
    <Group gap={GAP.tight} wrap="nowrap">
      <Text size="xs" c="dimmed" w={96} style={{ flex: 'none' }}>{k}</Text>
      <Text size="xs" ff="monospace" truncate title={note ? `${v} (${note})` : v}>{v}</Text>
    </Group>
  )
}

// A text, list (tags), multi (pick several), choice (segmented), select, number or font field. The
// hint sits under the input, so the inputs in a row line up whatever the hint length.
// `tag` sits beside the label; `dimmed` renders an inherited value; `disabled` a
// read-only one; `error` marks a text field invalid.
const WRAP: ('label' | 'input' | 'description' | 'error')[] = ['label', 'input', 'description', 'error']
const WRAP_STYLES = { label: { marginBottom: 6 }, description: { marginTop: 6 } }
function FieldInput({ spec, value, onChange, dimmed, placeholder, tag, disabled, error }: {
  spec: FieldSpec; value: Val; onChange: (v: Val) => void; dimmed?: boolean; placeholder?: string; tag?: ReactNode; disabled?: boolean; error?: string | null
}) {
  const label = tag ? <Group gap={6} wrap="nowrap" component="span">{spec.label}{tag}</Group> : spec.label
  const faded = dimmed ? { opacity: 0.55 } : undefined
  if (spec.choices) return (
    <Input.Wrapper label={label} description={spec.hint} inputWrapperOrder={WRAP} styles={WRAP_STYLES}>
      <SegmentedControl size="sm" fullWidth data={spec.choices} value={value as string} onChange={onChange} style={faded} disabled={disabled} />
    </Input.Wrapper>
  )
  if (spec.font) return <FontInput kind={spec.font} label={label} hint={spec.hint} value={value as string} onChange={onChange} disabled={disabled} />
  if (spec.range) return (
    <NumberInput label={label} description={spec.hint} inputWrapperOrder={WRAP} min={spec.range[0]} max={spec.range[1]} allowDecimal={false}
      allowNegative={false} clampBehavior="strict" placeholder={placeholder ?? spec.placeholder} value={value as string}
      onChange={(v) => onChange(String(v))} disabled={disabled} styles={{ ...WRAP_STYLES, input: faded }} />
  )
  if (spec.select) return (
    <Select label={label} description={spec.hint} inputWrapperOrder={WRAP} data={spec.select} value={value as string}
      onChange={(v) => { if (v) onChange(v) }} allowDeselect={false} disabled={disabled} styles={{ ...WRAP_STYLES, input: faded }} />
  )
  if (spec.multi) return (
    <MultiSelect label={label} description={spec.hint} inputWrapperOrder={WRAP} data={spec.multi} placeholder={placeholder ?? spec.placeholder}
      value={value as string[]} onChange={onChange} clearable disabled={disabled} styles={WRAP_STYLES} />
  )
  if (spec.list) return (
    <TagsInput label={label} description={spec.hint} inputWrapperOrder={WRAP} placeholder={placeholder ?? 'add…'}
      value={value as string[]} onChange={onChange} styles={{ ...WRAP_STYLES, pillsList: faded }} />
  )
  return (
    <TextInput label={label} description={spec.hint} inputWrapperOrder={WRAP} placeholder={placeholder ?? spec.placeholder}
      value={value as string} onChange={(e) => onChange(e.currentTarget.value)} disabled={disabled} error={error} styles={{ ...WRAP_STYLES, input: faded }} />
  )
}

// Appears only with unsaved changes (or a result to show), sticky to the bottom of
// its scrolling pane so Save is always in reach.
function SaveBar({ dirty, onSave, onDiscard }: { dirty: boolean; onSave: () => Promise<string | null>; onDiscard?: () => void }) {
  const report = useContext(DirtyCtx)
  useEffect(() => { report?.(dirty); return () => report?.(false) }, [dirty, report])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const save = async () => {
    setSaving(true); setErr(null)
    const e = await onSave().catch((x) => String(x))
    setSaving(false)
    if (e) { setErr(e); return }
    setSaved(true); window.setTimeout(() => setSaved(false), 1600)
  }
  if (!dirty && !err && !saved) return null
  return (
    <Box style={{ position: 'sticky', bottom: 0, zIndex: 2 }}>
      <Group gap="sm" wrap="nowrap" px={14} py={10}
        style={{ background: 'var(--ck-surface)', border: '1px solid var(--ck-border)', borderRadius: 10, boxShadow: 'var(--mantine-shadow-md)' }}>
        <Text size="sm" style={{ flex: 1, minWidth: 0 }} c={err ? 'red' : saved && !dirty ? 'teal' : 'dimmed'} truncate>
          {err ?? (saved && !dirty ? 'Saved ✓' : 'Unsaved changes')}
        </Text>
        {onDiscard && dirty ? <Button size="xs" variant="subtle" color="gray" onClick={() => { setErr(null); onDiscard() }}>Discard</Button> : null}
        {dirty ? <Button size="xs" leftSection={<IconDeviceFloppy size={15} />} onClick={save} loading={saving}>Save</Button> : null}
      </Group>
    </Box>
  )
}

// ── Agents ──────────────────────────────────────────────────────────────────
// The plugin's agents (read-only; Customise writes an override of one) and the
// user's own in <data-home>/agents/. A cockpit dispatch runs a worker as the agent.

// override: editing a built-in's override, so the name is locked. ack: saving is
// allowed unchanged, to take a changed built-in on board.
type Editing = { agent: AgentDef; isNew: boolean; override: boolean; ack: boolean }
const AGENT_NAME = /^[a-z][a-z0-9-]{1,40}$/
const BLANK_AGENT: AgentDef = { name: '', description: '', tools: [], model: 'inherit', prompt: '' }
const agentDef = (a: AgentDef): AgentDef => ({ name: a.name, description: a.description, tools: a.tools, model: a.model, prompt: a.prompt })

function AgentsTab() {
  const [view, setView] = useState<AgentsView | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)

  useEffect(() => {
    let live = true
    getAgents().then((v) => { if (live) setView(v) }).catch(() => { if (live) setErr('could not load agents') })
    return () => { live = false }
  }, [])

  const run = async (op: AgentOp) => {
    const r = await editAgent(op).catch((e): { error: string } => ({ error: String(e) }))
    if ('error' in r) return r.error
    setView(r)
    return null
  }

  if (!view) return err ? <Alert color="red" variant="light" p="xs">{err}</Alert> : <Text size="sm" c="dimmed">Loading…</Text>
  const taken = new Set([...view.builtin, ...view.custom].map((a) => a.name))
  const toggle = (name: string) => {
    if (editing && !editing.isNew && editing.agent.name === name) setEditing(null)
    setOpen(open === name ? null : name)
  }
  const editingRow = editing && !editing.isNew ? editing.agent.name : null
  const editor = (e: Editing) => (
    <AgentEditor key={e.isNew ? '(new)' : e.agent.name} editing={e} choices={view.choices} taken={taken} onCancel={() => setEditing(null)}
      onSave={async (agent) => {
        const x = await run({ op: 'save', agent, isNew: e.isNew })
        if (!x) { setEditing(null); setOpen(agent.name) }
        return x
      }} />
  )

  return (
    <SubTabs tabs={[{ value: 'builtin', label: 'Built-in', content: (
      <Section description="Shipped with the plugin. Customise one to run your version in cockpit dispatches; headless (Task) dispatches still use the plugin's.">
        <Stack gap={2}>
          {view.builtin.map((b) => (
            <ExpandRow key={b.name} open={open === b.name} onToggle={() => toggle(b.name)} head={(
              <AgentHead a={b.override ?? b} tags={b.override ? (
                <>
                  <Badge size="xs" variant="light" color="teal">customised</Badge>
                  {b.override.stale ? <Badge size="xs" variant="light" color="orange">built-in updated</Badge> : null}
                </>
              ) : null} />
            )}>
              {editingRow === b.name && editing ? editor(editing) : (
                <BuiltinPanel b={b} onReset={() => run({ op: 'delete', name: b.name })}
                  onCustomise={() => setEditing({ agent: agentDef(b.override ?? b), isNew: false, override: true, ack: !!b.override?.stale })} />
              )}
            </ExpandRow>
          ))}
        </Stack>
      </Section>
    ) }, { value: 'yours', label: 'Your agents', content: (
      <Section
        description="<data-home>/agents/ — yours, kept across plugin updates. Jeeves runs one when you ask (run <agent> on <ticket | #pr | repo>) and may suggest one when an item matches its description."
        right={(
          <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} disabled={!!editing?.isNew} style={{ flex: 'none' }}
            onClick={() => setEditing({ agent: BLANK_AGENT, isNew: true, override: false, ack: false })}>New agent</Button>
        )}>
        <Stack gap={GAP.tight}>
          {editing?.isNew ? <Box px={16} py={14} style={{ background: 'var(--ck-page)', borderRadius: 8 }}>{editor(editing)}</Box> : null}
          {view.custom.length === 0 ? (editing?.isNew ? null : <Text size="sm" c="dimmed">None yet.</Text>) : (
            <Stack gap={2}>
              {view.custom.map((a) => (
                <ExpandRow key={a.name} open={open === a.name} onToggle={() => toggle(a.name)} head={<AgentHead a={a} />}>
                  {editingRow === a.name && editing ? editor(editing) : (
                    <AgentBody a={a}>
                      <ConfirmActions
                        actions={<Button size="xs" variant="default" leftSection={<IconPencil size={14} />}
                          onClick={() => setEditing({ agent: agentDef(a), isNew: false, override: false, ack: false })}>Edit</Button>}
                        confirm={{ label: 'Delete', icon: <IconTrash size={14} />, question: `Delete ${a.name}? Its file in <data-home>/agents/ is removed.`, onConfirm: () => run({ op: 'delete', name: a.name }) }} />
                    </AgentBody>
                  )}
                </ExpandRow>
              ))}
            </Stack>
          )}
        </Stack>
      </Section>
    ) }]} />
  )
}

function AgentHead({ a, tags }: { a: AgentDef; tags?: ReactNode }) {
  return (
    <>
      <Text size="sm" fw={600} ff="monospace" style={{ flex: 'none' }}>{a.name}</Text>
      {tags ? <Group gap={4} wrap="nowrap" style={{ flex: 'none' }}>{tags}</Group> : null}
      <Text size="xs" c="dimmed" truncate style={{ flex: 1, minWidth: 0 }} title={a.description}>{a.description}</Text>
      <Text size="xs" c="dimmed" ff="monospace" style={{ flex: 'none' }}>{a.model}</Text>
    </>
  )
}

// One agent's definition, read-only, then `children` (its actions).
function AgentBody({ a, children }: { a: AgentDef; children?: ReactNode }) {
  return (
    <Stack gap={GAP.head}>
      <Text size="xs">{a.description}</Text>
      <Stack gap={6}>
        <KV k="Model" v={a.model} />
        <KV k="Tools" v={a.tools.length ? a.tools.join(', ') : 'all (inherited)'} />
      </Stack>
      <ReadOnlyText text={a.prompt} />
      {children}
    </Stack>
  )
}

// A built-in: the definition in force (the user's override when there is one), a
// flag when the built-in changed after it was customised, and the current built-in to compare.
function BuiltinPanel({ b, onCustomise, onReset }: { b: BuiltinAgent; onCustomise: () => void; onReset: () => Promise<string | null> }) {
  const [showBase, setShowBase] = useState(false)
  const o = b.override
  const customise = <Button size="xs" variant="default" leftSection={o ? <IconPencil size={14} /> : <IconWand size={14} />} onClick={onCustomise}>{o ? 'Edit' : 'Customise'}</Button>
  if (!o) return <AgentBody a={b}><Group gap={GAP.tight}>{customise}</Group></AgentBody>
  return (
    <Stack gap={GAP.field}>
      {o.stale ? (
        <Alert color="orange" variant="light" p="xs" icon={<IconAlertTriangle size={16} />}>
          Built-in updated since you customised — review it below, then Edit and save to keep your version.
        </Alert>
      ) : null}
      <AgentBody a={o}>
        <ConfirmActions actions={customise}
          confirm={{ label: 'Reset to built-in', icon: <IconArrowBackUp size={14} />, question: `Reset ${b.name} to the built-in? Your version is deleted.`, onConfirm: onReset }} />
      </AgentBody>
      <ExpandRow open={showBase} onToggle={() => setShowBase(!showBase)} head={<>
        <Text size="sm" fw={600}>Built-in</Text>
        <Text size="xs" c="dimmed">current plugin version · read-only</Text>
      </>}>
        <AgentBody a={b} />
      </ExpandRow>
    </Stack>
  )
}

// Action buttons plus one that asks before it acts (inline, like Rotate token).
function ConfirmActions({ actions, confirm }: {
  actions: ReactNode
  confirm: { label: string; icon: ReactNode; question: string; onConfirm: () => Promise<string | null> }
}) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const go = async () => {
    setBusy(true); setErr(null)
    const e = await confirm.onConfirm()
    setBusy(false)
    if (e) setErr(e); else setAsking(false)
  }
  return (
    <Stack gap={GAP.tight}>
      <Group gap={GAP.tight}>
        {actions}
        <Button size="xs" variant="default" color="red" leftSection={confirm.icon} disabled={asking} onClick={() => setAsking(true)}>{confirm.label}</Button>
      </Group>
      {asking ? (
        <Alert color="orange" variant="light" p="sm">
          <Stack gap={GAP.tight}>
            <Text size="sm">{confirm.question}</Text>
            {err ? <Text size="xs" c="red">{err}</Text> : null}
            <Group gap={GAP.tight}>
              <Button size="xs" color="orange" loading={busy} onClick={go}>{confirm.label}</Button>
              <Button size="xs" variant="subtle" color="gray" onClick={() => { setAsking(false); setErr(null) }}>Cancel</Button>
            </Group>
          </Stack>
        </Alert>
      ) : null}
    </Stack>
  )
}

function AgentEditor({ editing, choices, taken, onSave, onCancel }: {
  editing: Editing; choices: AgentsView['choices']; taken: Set<string>
  onSave: (a: AgentDef) => Promise<string | null>; onCancel: () => void
}) {
  const [d, setD] = useState<AgentDef>(editing.agent)
  const edit = (k: keyof AgentDef) => (v: Val) => setD((x) => ({ ...x, [k]: v }))
  const nameErr = !editing.isNew || !d.name ? null
    : !AGENT_NAME.test(d.name) ? 'Lowercase letters, digits and -, starting with a letter (2–41 characters).'
    : taken.has(d.name) ? 'Taken — to change a built-in, Customise it from its row.' : null
  const dirty = editing.ack || JSON.stringify(d) !== JSON.stringify(editing.agent)
  const save = async () => {
    if (!AGENT_NAME.test(d.name) || nameErr) return nameErr ?? 'A name is required.'
    if (!d.description.trim() || !d.prompt.trim()) return 'Description and prompt are required.'
    return onSave({ ...d, description: d.description.trim() })
  }
  const title = editing.isNew ? 'New agent' : `${editing.override ? 'Customise' : 'Edit'} ${d.name}`
  return (
    <Stack gap={GAP.field}>
      <Group justify="space-between" wrap="nowrap">
        <Text size="sm" fw={600}>{title}</Text>
        <Button size="xs" variant="default" leftSection={<IconX size={14} />} onClick={onCancel} style={{ flex: 'none' }}>Cancel</Button>
      </Group>
      <SimpleGrid cols={2} spacing={GAP.field} verticalSpacing={GAP.field}>
        <FieldInput spec={{ key: 'name', label: 'Name', hint: 'What you type in run <name> on …', placeholder: 'e.g. security-audit' }}
          value={d.name} onChange={edit('name')} disabled={!editing.isNew} error={nameErr} />
        <FieldInput spec={{ key: 'model', label: 'Model', select: choices.models, hint: 'inherit = the worker model (Settings → Loop).' }}
          value={d.model} onChange={edit('model')} />
      </SimpleGrid>
      <FieldInput spec={{ key: 'description', label: 'When to use it', hint: 'One line. The loop matches items against this to suggest the agent.' }}
        value={d.description} onChange={edit('description')} />
      <FieldInput spec={{ key: 'tools', label: 'Tools', multi: choices.tools, hint: 'Empty = every tool.', placeholder: 'all tools' }}
        value={d.tools} onChange={edit('tools')} />
      <Textarea label="Prompt" description="The agent's system prompt." value={d.prompt} onChange={(e) => edit('prompt')(e.currentTarget.value)}
        autosize minRows={10} maxRows={26} styles={MONO_TEXTAREA} />
      <SaveBar dirty={dirty} onSave={save} onDiscard={onCancel} />
    </Stack>
  )
}

// ── Jeeves: Loop, Rules, Reminders ──────────────────────────────────────────
// Loop: cockpit.json models and autonomy, defaults.md loop fields. Rules: loop
// constraints and what the guard refused. Reminders: reminders.md.

function LoopTab({ view, s, write, onSaved }: { view: ConfigView; s: SettingsView; write: Write; onSaved: (v: SettingsView) => void }) {
  const c = s.cockpit.choices
  return (
    <Stack gap={GAP.section}>
      <Intro>How Jeeves runs. The loop reads these when it launches, so most apply on the orchestrator's next Restart.</Intro>
      <SubTabs tabs={[
        { value: 'models', label: 'Models & permissions', content: (
          <CockpitForm s={s.cockpit} onSaved={onSaved} sections={[
            { title: 'Orchestrator', description: 'The session that runs the loop. Applies on its next Restart.', specs: [
              { key: 'orchModel', label: 'Model', select: c.models },
              { key: 'orchEffort', label: 'Effort', choices: c.efforts, hint: 'Reasoning effort for the loop.' },
              { key: 'orchPermission', label: 'Permission mode', select: c.permissionModes, hint: "Match the workers' so their messages arrive without approval." },
              { key: 'atlassianServer', label: 'Atlassian MCP server', hint: 'Its name as tool names spell it (mcp__<name>__getJiraIssue). The server the loop uses for Jira and Confluence.' }
            ] },
            { title: 'Workers', description: 'Sessions the loop dispatches. Applies to the next dispatch.', specs: [
              { key: 'workerModel', label: 'Model', select: c.models, hint: 'Any Opus the loop asks for runs as this if it is an Opus, else Opus 5.5.' },
              { key: 'workerPermission', label: 'Permission mode', select: c.permissionModes, hint: "Match the orchestrator's." }
            ] }
          ]} />
        ) },
        { value: 'schedule', label: 'Schedule', content: (
          <DefaultsForm view={view} write={write} sections={[{ description: 'How long the loop waits between ticks. Blank = the default shown.', specs: SCHEDULE }]} />
        ) },
        { value: 'messages', label: 'Messages', content: (
          <DefaultsForm view={view} write={write} sections={[{ description: 'How Jeeves talks to you, and the daily round-up.', specs: MESSAGES }]} />
        ) },
        { value: 'notify', label: 'Notifications', content: (
          <DefaultsForm view={view} write={write} sections={[{ description: 'Claude Code push notifications the loop sends.', specs: NOTIFY }]} />
        ) }
      ]} />
    </Stack>
  )
}

function RulesTab({ s, onSaved }: { s: SettingsView; onSaved: (v: SettingsView) => void }) {
  return (
    <Stack gap={GAP.section}>
      <Intro>What the orchestrator may do itself; anything else it dispatches to a worker.</Intro>
      <SubTabs tabs={[
        { value: 'constraints', label: 'Constraints', content: <ConstraintsSection s={s} onSaved={onSaved} /> },
        { value: 'guard', label: 'Guard refusals', content: <GuardSection /> }
      ]} />
    </Stack>
  )
}

// ── Cockpit: Sessions & access, Appearance ──────────────────────────────────

function CockpitTab({ s, onSaved }: { s: SettingsView; onSaved: (v: SettingsView) => void }) {
  return (
    <SubTabs tabs={[
      { value: 'sessions', label: 'Sessions', content: (
        <CockpitForm s={s.cockpit} onSaved={onSaved} sections={[
          { description: 'When a tab needs a restart, compacts or ends. Takes effect at once.', specs: [
            { key: 'rotatePct', label: 'Restart threshold (%)', range: [1, 100], hint: 'The context badge turns red and Restart lights at this share of the window.' },
            { key: 'compactPct', label: 'Auto-compact threshold (%)', range: [0, 100], hint: 'Between ticks, with no worker running, the orchestrator runs /compact at this share; 0 = never.' },
            { key: 'detachMinutes', label: 'Detached tab lifetime (min)', range: [0, 10080], hint: 'A tab with no browser attached ends after this; 0 = never. The orchestrator and workers never do.' }
          ] }
        ]} />
      ) },
      { value: 'claude', label: 'Claude Code', content: (
        <Stack gap="xl">
          <CockpitForm s={s.cockpit} onSaved={onSaved} sections={[
            { title: 'Display', description: 'For Claude sessions the cockpit starts from now on (tabs, workers, the orchestrator on its next Restart).', specs: [
              { key: 'claudeTui', label: 'Renderer', choices: ['fullscreen', 'default'], hint: 'fullscreen: Claude draws the whole pane and scrolls it itself. default: the classic inline renderer.' },
              { key: 'scrollSpeed', label: 'Fullscreen scroll speed', range: [1, 20], hint: 'Lines per mouse-wheel step in fullscreen; Claude still accelerates fast scrolls.' }
            ] }
          ]} />
          <StatusLineSection />
        </Stack>
      ) },
      { value: 'access', label: 'Access', content: <CockpitInfo s={s} onSaved={onSaved} /> }
    ]} />
  )
}

type CockpitSpec = FieldSpec & { key: CockpitKey }
type FormSection<T> = { title?: string; description?: string; specs: T[] }

// cockpit.json settings under one or more section headings, sharing one save bar.
// A value pinned by an env var is read-only here; a blank number, or a value equal
// to the default, resets to the default. `resettable` adds a Reset to defaults action.
function CockpitForm({ s, sections, onSaved, resettable }: { s: CockpitView; sections: FormSection<CockpitSpec>[]; onSaved: (v: SettingsView) => void; resettable?: boolean }) {
  const specs = sections.flatMap((x) => x.specs)
  const f = useFlatForm(Object.fromEntries(specs.map((x) => [x.key, String(s.values[x.key])])), specs)
  const [resets, setResets] = useState(0) // remounts the inputs so each re-derives its local state
  const save = async () => {
    const { set, unset } = f.payload()
    for (const [k, v] of Object.entries(set)) if (v === String(s.defaults[k as CockpitKey])) { delete set[k]; unset.push(k) }
    const r = await saveSettings({ cockpit: { set, unset } }).catch((e): { error: string } => ({ error: String(e) }))
    if ('error' in r) return r.error
    onSaved(r); f.clear()
    return null
  }
  const reset = () => {
    for (const x of specs) if (!s.pinned[x.key]) f.edit(x.key, String(s.defaults[x.key]))
    setResets((n) => n + 1)
  }
  const atDefaults = specs.every((x) => s.pinned[x.key] || f.get(x) === String(s.defaults[x.key]))
  const bypass = specs.some((x) => f.get(x) === 'bypassPermissions')
  return (
    <Stack gap={GAP.section}>
      {sections.map((sec) => (
        <Section key={sec.title ?? ''} title={sec.title} description={sec.description} file="cockpit.json">
          <SimpleGrid key={resets} cols={2} spacing={GAP.field} verticalSpacing={GAP.field}>
            {sec.specs.map((x) => {
              const env = s.pinned[x.key]
              return (
                <FieldInput key={x.key} spec={x} value={f.get(x)} onChange={(v) => f.edit(x.key, v)} disabled={!!env}
                  placeholder={String(s.defaults[x.key])}
                  tag={env ? (
                    <Tooltip label={`Set by $${env} — unset it to edit here`} openDelay={300} withArrow>
                      <Badge size="xs" variant="light" color="gray">${env}</Badge>
                    </Tooltip>
                  ) : undefined} />
              )
            })}
          </SimpleGrid>
        </Section>
      ))}
      {bypass ? (
        <Group gap={6} wrap="nowrap">
          <IconAlertTriangle size={15} color="var(--mantine-color-orange-6)" style={{ flex: 'none' }} />
          <Text size="xs" c="orange">bypassPermissions skips every permission check — that session runs any command without asking.</Text>
        </Group>
      ) : null}
      {resettable ? (
        <Group gap={GAP.tight}>
          <Button size="xs" variant="default" leftSection={<IconArrowBackUp size={14} />} disabled={atDefaults} onClick={reset}>Reset to defaults</Button>
        </Group>
      ) : null}
      <SaveBar dirty={f.changed.length > 0} onSave={save} onDiscard={f.clear} />
    </Stack>
  )
}

// defaults.md loop fields: `dflt` is what the loop uses when the field is unset;
// `dependsOn` dims a field while the switch it depends on is off.
type LoopSpec = FieldSpec & { dflt?: string; dependsOn?: string }
const ON_OFF = ['on', 'off']
const SCHEDULE: LoopSpec[] = [
  { key: 'tickSeconds', label: 'Tick (seconds)', dflt: '300', hint: 'Normal wait between ticks.' },
  { key: 'tickMidFlightSeconds', label: 'Mid-flight tick (seconds)', dflt: '120', hint: 'While a worker is running.' },
  { key: 'overnight', label: 'Overnight window', dflt: '22:00-08:00', hint: 'HH:MM-HH:MM, local time.' },
  { key: 'tickOvernightSeconds', label: 'Overnight tick (seconds)', dflt: '1800', hint: 'Inside the overnight window.' }
]
const MESSAGES: LoopSpec[] = [
  { key: 'dailySummary', label: 'Daily summary', dflt: 'on', choices: ON_OFF, hint: 'Done since yesterday, in flight, waiting on you.' },
  { key: 'dailySummaryAt', label: 'Daily summary at', dflt: '09:00', dependsOn: 'dailySummary', hint: 'The first tick after this time, once a day.' },
  { key: 'voice', label: 'Voice', dflt: 'plain, direct', hint: 'e.g. "British, dry". Brevity and no filler apply whatever you pick.' }
]
const NOTIFY: LoopSpec[] = [
  { key: 'pushNotifications', label: 'Push notifications', dflt: 'on', choices: ON_OFF, hint: 'Off silences every kind below.' },
  { key: 'notifyReminders', label: 'Reminders due', dflt: 'on', choices: ON_OFF, dependsOn: 'pushNotifications', hint: 'When a reminder falls due.' },
  { key: 'notifyWorkerFinished', label: 'Worker finished', dflt: 'on', choices: ON_OFF, dependsOn: 'pushNotifications', hint: "When a dispatched worker's report lands." },
  { key: 'notifyReviewReady', label: 'Review ready', dflt: 'on', choices: ON_OFF, dependsOn: 'pushNotifications', hint: "When a reviewer's compiled report lands." }
]

// defaults.md fields under one or more section headings, sharing one save bar.
function DefaultsForm({ sections, view, write }: { sections: FormSection<LoopSpec>[]; view: ConfigView; write: Write }) {
  const specs = sections.flatMap((x) => x.specs)
  const raw = view.defaults.values as unknown as Record<string, Val | null>
  // A switch shows its default when unset; a text field stays blank with the default as placeholder.
  const f = useFlatForm(Object.fromEntries(specs.map((x) => [x.key, raw[x.key] ?? (x.choices ? x.dflt ?? null : null)])), specs)
  const save = async () => { const e = await write({ file: 'defaults', ...f.payload() }); if (!e) f.clear(); return e }
  const off = (key?: string) => { const d = key ? specs.find((x) => x.key === key) : undefined; return !!d && f.get(d) === 'off' }
  return (
    <Stack gap={GAP.section}>
      {sections.map((sec) => (
        <Section key={sec.title ?? ''} title={sec.title} description={sec.description} file="defaults.md">
          <SimpleGrid cols={2} spacing={GAP.field} verticalSpacing={GAP.field}>
            {sec.specs.map((x) => (
              <FieldInput key={x.key} spec={x} value={f.get(x)} onChange={(v) => f.edit(x.key, v)} placeholder={x.dflt} dimmed={off(x.dependsOn)} />
            ))}
          </SimpleGrid>
        </Section>
      ))}
      <SaveBar dirty={f.changed.length > 0} onSave={save} onDiscard={f.clear} />
    </Stack>
  )
}

// The Claude Code status line: dir:branch · model / effort, then ctx % · 5h % · 7d % with
// time to reset. Installing copies it to ~/.claude and sets settings.json's statusLine.
function StatusLineSection() {
  const [v, setV] = useState<StatusLineView | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { getStatusLine().then(setV).catch(() => setV({ current: null, installed: false, error: 'could not read ~/.claude/settings.json' })) }, [])
  const install = async (replace: boolean) => {
    setBusy(true)
    const r = await installStatusLine(replace).catch((e): StatusLineView => ({ current: v?.current ?? null, installed: false, error: String(e) }))
    setBusy(false); setV(r)
  }
  return (
    <Section file="~/.claude/settings.json"
      description="Two lines under every Claude Code prompt: folder:branch · model / effort, then context, 5-hour and 7-day usage with time to reset. Applies to Claude sessions started afterwards.">
      <Stack gap={8}>
        <Text size="xs" c="dimmed">Current: <Text span ff="monospace" size="xs">{v?.current ?? 'none'}</Text></Text>
        {v?.error ? <Alert color="red" variant="light">{v.error}</Alert> : null}
        {v?.needsConfirm ? (
          <Alert color="yellow" variant="light" title="Replace your status line?">
            <Text size="sm" mb={8}>You already use <Text span ff="monospace">{v.current}</Text>. Installing replaces it (settings.json is backed up).</Text>
            <Group gap={8}><Button size="compact-sm" color="yellow" loading={busy} onClick={() => install(true)}>Replace</Button><Button size="compact-sm" variant="subtle" color="gray" onClick={() => setV({ ...v, needsConfirm: false })}>Keep mine</Button></Group>
          </Alert>
        ) : (
          <Group gap={8}>
            <Button size="compact-sm" loading={busy} disabled={!v} onClick={() => install(false)}>{v?.installed ? 'Reinstall' : 'Install'}</Button>
            {v?.installed ? <Text size="xs" c="teal">Installed</Text> : null}
          </Group>
        )}
      </Stack>
    </Section>
  )
}

// What the orchestrator's guard refused (guard.log), newest first: a refusal it genuinely
// needed is a case for loosening bin/guard-orchestrator.mjs.
function GuardSection() {
  const [rows, setRows] = useState<GuardRow[] | null>(null)
  const load = () => { getGuardLog().then((r) => setRows(r.rows)).catch(() => setRows([])) }
  useEffect(load, [])
  const when = (at: string) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return (
    <Section description="What the orchestrator tried itself and was stopped from doing. One it genuinely needed means the guard should allow it."
      file="guard.log" right={<Button size="compact-xs" variant="subtle" color="gray" onClick={load}>Refresh</Button>}>
      {rows === null ? <Text size="sm" c="dimmed">Loading…</Text> : !rows.length ? <Text size="sm" c="dimmed">Nothing refused yet.</Text> : (
        <Stack gap={8}>
          {rows.slice(0, 30).map((r, i) => (
            <Box key={i}>
              <Group gap={8} wrap="nowrap">
                <Badge size="xs" variant="light" color={r.allowed ? 'teal' : 'gray'} style={{ flex: 'none' }}>{r.allowed ? 'ran for you' : r.tool}</Badge>
                <Text size="xs" ff="monospace" truncate style={{ minWidth: 0 }}>{r.what}</Text>
                <Text size="xs" c="dimmed" ml="auto" style={{ flex: 'none' }}>{when(r.at)}</Text>
              </Group>
              <Text size="xs" c="dimmed" lh={1.4}>{r.why}</Text>
            </Box>
          ))}
        </Stack>
      )}
    </Section>
  )
}

// reminders.md, shared with the loop (it re-reads the file every tick).
const dueDate = (due: string) => new Date(due.replace(' ', 'T'))
function RemindersSection() {
  const [rows, setRows] = useState<Reminder[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [what, setWhat] = useState('')
  const [due, setDue] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    getReminders().then((r) => { if (live) setRows(r.reminders) }).catch(() => { if (live) setErr('could not load reminders') })
    return () => { live = false }
  }, [])

  const run = async (op: ReminderOp) => {
    setBusy(true); setErr(null)
    const r = await editReminder(op).catch((e): { error: string } => ({ error: String(e) }))
    setBusy(false)
    if ('error' in r) { setErr(r.error); return false }
    setRows(r.reminders)
    return true
  }
  const add = async () => { if (await run({ op: 'add', what, due })) { setWhat(''); setDue('') } }

  const now = Date.now()
  const sorted = [...(rows ?? [])].sort((a, b) => a.due.localeCompare(b.due))
  const icon = (label: string, node: ReactNode, op: ReminderOp, color: string) => (
    <Tooltip label={label} openDelay={300} withArrow>
      <ActionIcon size="sm" variant="subtle" color={color} disabled={busy} onClick={() => run(op)} aria-label={label}>{node}</ActionIcon>
    </Tooltip>
  )
  const snooze = (id: string, by: '1h' | '1d') => (
    <Button size="compact-xs" variant="subtle" color="gray" disabled={busy} onClick={() => run({ op: 'snooze', id, by })}>+{by}</Button>
  )
  return (
    <Section title="Reminders" description="The loop surfaces each one when it falls due, and picks up changes here on its next tick." file="reminders.md">
      <Stack gap={GAP.field}>
        {rows == null ? (err ? null : <Text size="xs" c="dimmed">Loading…</Text>)
          : sorted.length === 0 ? <Text size="xs" c="dimmed">None pending.</Text> : (
            <Table fz="xs" verticalSpacing={6} horizontalSpacing={8} withRowBorders={false}
              styles={{ table: { background: 'var(--ck-surface)', borderRadius: 8 }, th: { color: 'var(--mantine-color-dimmed)', fontWeight: 600 } }}>
              <Table.Thead>
                <Table.Tr><Table.Th>Due</Table.Th><Table.Th>What</Table.Th><Table.Th>Id</Table.Th><Table.Th /></Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {sorted.map((r) => {
                  const overdue = dueDate(r.due).getTime() <= now
                  return (
                    <Table.Tr key={r.id} style={overdue ? { background: 'var(--mantine-color-red-light)' } : undefined}>
                      <Table.Td className="ck-num" c={overdue ? 'red' : undefined} fw={overdue ? 600 : undefined} style={{ whiteSpace: 'nowrap' }}>
                        {r.due}{overdue ? ' · overdue' : ''}
                      </Table.Td>
                      <Table.Td>{r.what}</Table.Td>
                      <Table.Td c="dimmed" ff="monospace">{r.id}</Table.Td>
                      <Table.Td style={{ whiteSpace: 'nowrap', width: 1 }}>
                        <Group gap={2} wrap="nowrap">
                          {icon('Done', <IconCheck size={14} />, { op: 'done', id: r.id }, 'teal')}
                          {snooze(r.id, '1h')}
                          {snooze(r.id, '1d')}
                          {icon('Delete', <IconTrash size={14} />, { op: 'delete', id: r.id }, 'red')}
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  )
                })}
              </Table.Tbody>
            </Table>
          )}
        <Group gap={GAP.tight} align="flex-end" wrap="nowrap">
          <TextInput label="Add reminder" placeholder="What to be reminded of" value={what} onChange={(e) => setWhat(e.currentTarget.value)}
            style={{ flex: 1 }} styles={WRAP_STYLES} />
          <TextInput label="Due" type="datetime-local" value={due} onChange={(e) => setDue(e.currentTarget.value)} styles={WRAP_STYLES} />
          <Button leftSection={<IconPlus size={14} />} disabled={!what.trim() || !due} loading={busy} onClick={add}>Add</Button>
        </Group>
        {err ? <Alert color="red" variant="light" p="xs">{err}</Alert> : null}
      </Stack>
    </Section>
  )
}

function ConstraintsSection({ s, onSaved }: { s: SettingsView; onSaved: (v: SettingsView) => void }) {
  const [text, setText] = useState(s.loopConstraints)
  const [showBase, setShowBase] = useState(false)
  const save = async () => {
    const r = await saveSettings({ loopConstraints: text }).catch((e): { error: string } => ({ error: String(e) }))
    if ('error' in r) return r.error
    onSaved(r)
    return null
  }
  return (
    <Section
      description="The shipped baseline always applies; your additions layer on top and win on a direct conflict. Applies on the orchestrator's next Restart.">
      <Stack gap={GAP.field}>
        <ExpandRow open={showBase} onToggle={() => setShowBase(!showBase)} head={<>
          <Text size="sm" fw={600}>Baseline</Text>
          <Text size="xs" c="dimmed">shipped with the plugin · read-only</Text>
        </>}>
          <ReadOnlyText text={s.baseline || '(not found)'} />
        </ExpandRow>
        <Textarea label="Your additions" value={text} onChange={(e) => setText(e.currentTarget.value)}
          autosize minRows={10} maxRows={26} styles={MONO_TEXTAREA} />
        <SaveBar dirty={text !== s.loopConstraints} onSave={save} onDiscard={() => setText(s.loopConstraints)} />
      </Stack>
    </Section>
  )
}

function CockpitInfo({ s, onSaved }: { s: SettingsView; onSaved: (v: SettingsView) => void }) {
  const [copied, setCopied] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const copy = async () => {
    try { await navigator.clipboard.writeText(s.url); setCopied(true); window.setTimeout(() => setCopied(false), 1600) }
    catch { setMsg({ ok: false, text: 'Clipboard unavailable — copy the URL from the server log.' }) }
  }
  const rotate = async () => {
    setRotating(true); setMsg(null)
    const r = await saveSettings({ rotateToken: true }).catch((e): { error: string } => ({ error: String(e) }))
    setRotating(false); setConfirming(false)
    if ('error' in r) { setMsg({ ok: false, text: r.error }); return }
    if (r.token) setToken(r.token)
    onSaved(r)
    setMsg({ ok: true, text: 'Token rotated. This tab carries on; copy the new URL for any other.' })
  }

  return (
    <Section description="Where this cockpit lives and how to reach it.">
      <Stack gap={GAP.field}>
        <Stack gap={6} p={12} style={{ background: 'var(--ck-page)', borderRadius: 8 }}>
          <KV k="Data home" v={s.home} />
          <KV k="Server" v={`${s.host}:${s.port}`} />
        </Stack>
        <Group gap={GAP.tight}>
          <Button size="xs" variant="light" leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />} onClick={copy}>
            {copied ? 'Copied' : 'Copy cockpit URL'}
          </Button>
          <Tooltip label="Set by $JEEVES_TOKEN — unset it to rotate here" disabled={!s.tokenPinned} openDelay={300} withArrow>
            <Button size="xs" variant="default" leftSection={<IconKey size={14} />} disabled={s.tokenPinned || confirming} onClick={() => setConfirming(true)}>
              Rotate token
            </Button>
          </Tooltip>
        </Group>
        {confirming ? (
          <Alert color="orange" variant="light" p="sm">
            <Stack gap={GAP.tight}>
              <Text size="sm">Rotate the access token? The old one stops working at once, so any other open cockpit tab needs the new URL. This tab switches over by itself.</Text>
              <Group gap={GAP.tight}>
                <Button size="xs" color="orange" loading={rotating} onClick={rotate}>Rotate</Button>
                <Button size="xs" variant="subtle" color="gray" onClick={() => setConfirming(false)}>Cancel</Button>
              </Group>
            </Stack>
          </Alert>
        ) : null}
        {msg ? <Text size="xs" c={msg.ok ? 'teal' : 'red'}>{msg.text}</Text> : null}
      </Stack>
    </Section>
  )
}

// ── Appearance ──────────────────────────────────────────────────────────────
// cockpit.json fonts. Every browser loads them from /api/config, and a save
// re-applies them in every open tab.

// Sans families on Google Fonts, checked against fonts.googleapis.com/css2.
const UI_FONTS = [
  'IBM Plex Sans', 'Inter', 'Roboto', 'Open Sans', 'Source Sans 3', 'Noto Sans', 'Lato', 'Nunito Sans', 'Work Sans',
  'DM Sans', 'Manrope', 'Plus Jakarta Sans', 'Figtree', 'Outfit', 'Geist', 'Public Sans', 'Rubik', 'Karla', 'Mulish',
  'Barlow', 'Atkinson Hyperlegible', 'Lexend', 'Red Hat Text', 'Sora', 'Onest'
]
const MONO_FONTS = [
  'IBM Plex Mono', 'JetBrains Mono', 'Fira Code', 'Source Code Pro', 'Roboto Mono', 'Ubuntu Mono', 'Inconsolata',
  'Space Mono', 'DM Mono', 'Red Hat Mono', 'Geist Mono', 'Martian Mono'
]
const FONT_SAMPLE: Record<FontKind, string> = { ui: 'The quick brown fox — Stories · My PRs · fix/slow-build', mono: 'git status · const x = 0O1lI' }

function AppearanceTab({ s, onSaved }: { s: SettingsView; onSaved: (v: SettingsView) => void }) {
  return (
    <CockpitForm s={s.cockpit} onSaved={onSaved} resettable sections={[
      { title: 'Fonts', description: 'Every browser uses these. Saving applies them in every open cockpit tab at once.', specs: [
        { key: 'uiFont', label: 'UI font', font: 'ui', hint: 'Menus, the dashboard, Settings.' },
        { key: 'monoFont', label: 'Code & terminal font', font: 'mono', hint: 'Terminals, diffs, code in markdown.' },
        { key: 'terminalFontSize', label: 'Terminal font size (px)', range: [10, 20], hint: '10–20. Terminals refit to the new size.' }
      ] }
    ]} />
  )
}

// A searchable curated list with System default first and Other Google Font…
// last, which reveals a text box for any family name. The preview line renders in
// the chosen font, loaded as soon as it's picked, before anything is saved.
const OTHER_FONT = '(other)'
function FontInput({ kind, label, hint, value, onChange, disabled }: {
  kind: FontKind; label: ReactNode; hint?: string; value: string; onChange: (v: Val) => void; disabled?: boolean
}) {
  const list = kind === 'mono' ? MONO_FONTS : UI_FONTS
  const curated = value === 'system' || list.includes(value)
  const [other, setOther] = useState(!curated)
  const name = value.trim()
  const valid = FONT_NAME.test(name)
  useEffect(() => { if (valid) previewFont(name, kind) }, [name, valid, kind])
  const data = [{ value: 'system', label: 'System default' }, ...list.map((f) => ({ value: f, label: f })), { value: OTHER_FONT, label: 'Other Google Font…' }]
  return (
    <Stack gap={GAP.tight}>
      <Select label={label} description={hint} inputWrapperOrder={WRAP} styles={WRAP_STYLES} data={data} searchable allowDeselect={false}
        nothingFoundMessage="Not listed — pick Other Google Font…" disabled={disabled} value={other ? OTHER_FONT : value}
        onChange={(v) => {
          if (!v) return
          if (v === OTHER_FONT) { setOther(true); if (curated) onChange('') }
          else { setOther(false); onChange(v) }
        }} />
      {other ? (
        <TextInput placeholder="Family name as on fonts.google.com, e.g. Lexend Deca" value={value} disabled={disabled}
          onChange={(e) => onChange(e.currentTarget.value)}
          error={name && !valid ? 'Letters, digits, spaces and - only (up to 60).' : null} />
      ) : null}
      <Text size="sm" truncate p={10} title={FONT_SAMPLE[kind]}
        style={{ fontFamily: fontStack(valid ? name : 'system', kind), background: 'var(--ck-page)', borderRadius: 8 }}>
        {FONT_SAMPLE[kind]}
      </Text>
    </Stack>
  )
}
