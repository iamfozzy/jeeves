import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ActionIcon, Box, Group, Modal, Text, TextInput, Tooltip, UnstyledButton } from '@mantine/core'
import { IconPin, IconPinFilled, IconSearch } from '@tabler/icons-react'

// One row in the picker. `match` is the text the query is scored against;
// items render grouped in the order given, best match first within a group.
export type PickItem = {
  key: string
  group: string
  label: string
  sub?: string
  match: string
  dot?: string
  pinned?: boolean
  onTogglePin?: () => void
  onPick: () => void
}

// Lower is better; null = no match. A substring hit scores by its position
// (so a slug hit beats an id hit later in `match`); otherwise the query's
// characters in order anywhere ("fuzzy-ish") score behind every substring hit.
function score(q: string, text: string): number | null {
  const t = text.toLowerCase()
  const at = t.indexOf(q)
  if (at >= 0) return at
  let i = 0, first = -1
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) { if (first < 0) first = j; i++ }
  }
  return i === q.length ? 1000 + first : null
}

// Type-to-filter modal list, keyboard driven (↑/↓ move, Enter picks, Esc closes).
// Used for the sidebar's "Open space…" repo picker and the ⌘P quick switcher.
export function Picker({ opened, onClose, placeholder, items }: {
  opened: boolean
  onClose: () => void
  placeholder: string
  items: PickItem[]
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [picked, setPicked] = useState(false)
  const rows = useRef<(HTMLDivElement | null)[]>([])

  useEffect(() => { if (opened) { setQuery(''); setActive(0); setPicked(false) } }, [opened])

  const q = query.trim().toLowerCase()
  const groups: string[] = []
  const byGroup: Record<string, { it: PickItem; s: number; i: number }[]> = {}
  items.forEach((it, i) => {
    const s = q ? score(q, it.match) : 0
    if (s == null) return
    if (!byGroup[it.group]) { byGroup[it.group] = []; groups.push(it.group) }
    byGroup[it.group].push({ it, s, i })
  })
  for (const g of groups) byGroup[g].sort((a, b) => a.s - b.s || a.i - b.i)
  const shown = groups.flatMap((g) => byGroup[g].map((x) => x.it))
  const cur = Math.min(active, Math.max(shown.length - 1, 0))

  useEffect(() => { rows.current[cur]?.scrollIntoView({ block: 'nearest' }) }, [cur])

  const pick = (it: PickItem | undefined) => {
    if (!it) return
    setPicked(true)
    onClose()
    it.onPick()
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return
    const n = shown.length
    if (e.key === 'ArrowDown' && n) { e.preventDefault(); setActive((cur + 1) % n) }
    else if (e.key === 'ArrowUp' && n) { e.preventDefault(); setActive((cur - 1 + n) % n) }
    else if (e.key === 'Enter') { e.preventDefault(); pick(shown[cur]) }
  }

  // A pick hands focus to its destination (the terminal it selects, or the
  // open-space modal); only a dismissal returns focus to where it was.
  let idx = -1
  return (
    <Modal opened={opened} onClose={onClose} returnFocus={opened || !picked} withCloseButton={false} size="md" radius="md" yOffset="12vh" padding={0}>
      <Box p="sm" style={{ borderBottom: '1px solid var(--ck-border)' }}>
        <TextInput
          data-autofocus
          value={query}
          onChange={(e) => { setQuery(e.currentTarget.value); setActive(0) }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          leftSection={<IconSearch size={15} />}
          variant="unstyled"
        />
      </Box>
      <div style={{ maxHeight: 380, overflowY: 'auto', overflowX: 'hidden', padding: 6 }}>
        {shown.length === 0 && <Text size="sm" c="dimmed" px="sm" py="sm">{items.length ? `Nothing matches “${query}”.` : 'Nothing to pick.'}</Text>}
        {groups.map((g) => (
          <Box key={g}>
            <Text className="ck-label" px={9} pt={8} pb={4}>{g}</Text>
            {byGroup[g].map(({ it }) => {
              const i = ++idx
              return (
                <UnstyledButton
                  key={it.key}
                  component="div"
                  role="button"
                  tabIndex={0}
                  ref={(el) => { rows.current[i] = el }}
                  className="ck-space"
                  data-active={i === cur}
                  onClick={() => pick(it)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(it) } }}
                  onMouseMove={() => { if (i !== cur) setActive(i) }}
                  style={{ borderRadius: 8, padding: '7px 9px', width: '100%', background: i === cur ? 'var(--ck-active)' : 'transparent' }}
                >
                  <Group gap={9} wrap="nowrap">
                    <Box w={7} h={7} style={{ borderRadius: '50%', background: it.dot ?? 'transparent', flex: 'none' }} />
                    <Box style={{ flex: 1, minWidth: 0 }}>
                      <Text size="sm" fw={600} lh={1.25} truncate>{it.label}</Text>
                      {it.sub ? <Text size="xs" c="dimmed" ff="monospace" lh={1.3} truncate>{it.sub}</Text> : null}
                    </Box>
                    {it.onTogglePin && (
                      <Tooltip label={it.pinned ? 'Unpin from sidebar' : 'Pin to sidebar'} openDelay={400} withArrow>
                        <ActionIcon
                          className={it.pinned ? undefined : 'ck-x'}
                          size={20}
                          variant="subtle"
                          color={it.pinned ? 'cockpit' : 'gray'}
                          onClick={(e) => { e.stopPropagation(); it.onTogglePin?.() }}
                          aria-label={it.pinned ? 'Unpin repo' : 'Pin repo'}
                          style={{ flex: 'none' }}
                        >
                          {it.pinned ? <IconPinFilled size={14} /> : <IconPin size={14} />}
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </Group>
                </UnstyledButton>
              )
            })}
          </Box>
        ))}
      </div>
    </Modal>
  )
}
