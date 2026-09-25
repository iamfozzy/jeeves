import type { ReactNode } from 'react'
import { ActionIcon, Popover } from '@mantine/core'

// A × button (or `icon`) that asks before acting, in a popover anchored to the button —
// where the pointer already is — rather than a centred modal. `children` is the popover
// body; it mounts only while open, so any state inside resets on each ask.
export function CloseConfirm({ opened, onChange, label, size, icon, children }: {
  opened: boolean
  onChange: (opened: boolean) => void
  label: string
  size: number
  icon?: ReactNode
  children: ReactNode
}) {
  return (
    <Popover opened={opened} onChange={onChange} position="bottom" withArrow shadow="md" radius="md" trapFocus withinPortal>
      <Popover.Target>
        <ActionIcon className="ck-x" size={size} variant="subtle" color="gray" aria-label={label} style={{ flex: 'none' }}
          onClick={(e) => { e.stopPropagation(); onChange(!opened) }}>
          {icon ?? <span style={{ fontSize: 13, lineHeight: 1 }}>×</span>}
        </ActionIcon>
      </Popover.Target>
      {/* Portalled, but React events still bubble to the row/tab; keep them here. */}
      <Popover.Dropdown p={12} maw={340} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onAuxClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        {children}
      </Popover.Dropdown>
    </Popover>
  )
}
