import { useState, type ReactNode } from 'react'
import { Badge, Box, Collapse, Group, Text } from '@mantine/core'
import { IconChevronRight } from '@tabler/icons-react'

const KEY = 'jeeves-cockpit-sections'
const load = (): Record<string, boolean> => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') } catch { return {} } }

// A panel section: a full-bleed banded header on the app background tone over its
// body. Clicking the header folds the body; a folded section shows a chevron in
// place of its icon. Folded state persists per `id`. `right` holds the section's own
// controls (clicks there don't fold); `collapsible={false}` pins the section open.
export function Section({ id, label, icon: Icon, accent, count, right, px = 'md', collapsible = true, children }: {
  id: string; label: string; icon: typeof IconChevronRight; accent: string; count?: number; right?: ReactNode
  px?: string; collapsible?: boolean; children: ReactNode
}) {
  const [folded, setFolded] = useState(() => collapsible && !!load()[id])
  const toggle = () => {
    const next = !folded
    setFolded(next)
    try { const all = load(); if (next) all[id] = true; else delete all[id]; localStorage.setItem(KEY, JSON.stringify(all)) } catch {}
  }
  return (
    <Box className="ck-section">
      <Group gap={8} align="center" px={px} py={8} wrap="nowrap" className={collapsible ? 'ck-sechead ck-sectop' : 'ck-sectop'}
        style={{ background: 'var(--ck-page)' }} onClick={collapsible ? toggle : undefined}
        aria-expanded={collapsible ? !folded : undefined} title={collapsible ? (folded ? `Show ${label.toLowerCase()}` : `Hide ${label.toLowerCase()}`) : undefined}>
        <Box style={{ color: `var(--mantine-color-${accent}-5)`, display: 'flex' }}>
          {folded ? <IconChevronRight size={15} stroke={2.4} /> : <Icon size={15} stroke={2.2} />}
        </Box>
        <Text className="ck-label">{label}</Text>
        {count != null ? <Badge size="xs" variant="light" color={accent}>{count}</Badge> : null}
        {right ? <Box ml="auto" style={{ display: 'flex' }} onClick={(e) => e.stopPropagation()}>{right}</Box> : null}
      </Group>
      <Collapse in={!folded}>{children}</Collapse>
    </Box>
  )
}
