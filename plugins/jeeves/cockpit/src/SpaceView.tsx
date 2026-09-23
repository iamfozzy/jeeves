import { useEffect, useState } from 'react'
import { ActionIcon, Button, Group, Menu, Stack, Text, TextInput, Tooltip } from '@mantine/core'
import { IconBrandVscode, IconFolderOpen, IconLayoutSidebarRightCollapse, IconLayoutSidebarRightExpand, IconRobot, IconTerminal2 } from '@tabler/icons-react'
import { TerminalPane } from './TerminalPane'
import { SpacePanel } from './SpacePanel'
import { CloseConfirm } from './CloseConfirm'
import { openFolder } from './api'
import type { Space, TabKind } from './types'

const KIND: Record<TabKind, { label: string; color: string; icon: typeof IconRobot }> = {
  claude: { label: 'claude', color: 'var(--mantine-color-orange-5)', icon: IconRobot },
  codex: { label: 'codex', color: 'var(--mantine-color-blue-5)', icon: IconRobot },
  shell: { label: 'terminal', color: 'var(--mantine-color-dimmed)', icon: IconTerminal2 }
}
const KindIcon = ({ kind, size = 14 }: { kind: TabKind; size?: number }) => {
  const k = KIND[kind]
  return <k.icon size={size} stroke={2} style={{ color: k.color, flex: 'none' }} />
}

// A program-set title minus claude's leading status glyph (✳ idle, a spinner while working).
const cleanTitle = (t: string) => t.replace(/^[^\p{L}\p{N}]+/u, '').trim()

// The OS file manager's name, for the reveal button's tooltip.
const FILE_MANAGER = /Mac|iPhone|iPad/.test(navigator.platform) ? 'Finder'
  : /Win/.test(navigator.platform) ? 'Explorer' : 'file manager'

export function SpaceView({
  space,
  spaceActive,
  panel = true,
  panelOpen,
  onTogglePanel,
  onActivateTab,
  onAddTab,
  onCloseTab,
  onRenameTab,
  onMoveTab
}: {
  space: Space
  spaceActive: boolean
  panel?: boolean // show the git/PR side panel (off for the Scratchpad — home isn't a repo)
  panelOpen: boolean // the panel's shown/hidden state, shared by every space
  onTogglePanel: () => void
  onActivateTab: (tabId: string) => void
  onAddTab: (kind: TabKind) => void
  onCloseTab: (tabId: string) => void
  onRenameTab: (tabId: string, title: string) => void
  onMoveTab: (tabId: string, targetId: string, after: boolean) => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null) // the tab whose close is being confirmed
  // Drag to reorder: the tab being dragged, and where it would land (either side of a tab).
  const [dragId, setDragId] = useState<string | null>(null)
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null)
  const endDrag = () => { setDragId(null); setDrop(null) }
  // Titles the tabs' programs set, by tab id. Not persisted: claude sets it again on reattach.
  const [liveTitles, setLiveTitles] = useState<Record<string, string>>({})
  const setLiveTitle = (tabId: string, title: string) =>
    setLiveTitles((m) => (m[tabId] === title ? m : { ...m, [tabId]: title }))

  const startRename = (tabId: string, current: string) => { setEditingId(tabId); setDraft(current) }
  const commitRename = () => { if (editingId) onRenameTab(editingId, draft); setEditingId(null) }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Group
        gap={0}
        wrap="nowrap"
        style={{
          height: 41, // 40 of content + the 1px border; tabs fill the 40
          flex: 'none',
          background: 'var(--ck-surface)',
          borderBottom: '1px solid var(--ck-border)'
        }}
      >
        <Group gap={0} wrap="nowrap" style={{ flex: 1, minWidth: 0, height: '100%', overflowX: 'auto' }}>
          {space.tabs.map((t) => {
            const active = t.id === space.activeTabId
            const k = KIND[t.kind]
            const label = t.title || liveTitles[t.id] || k.label
            const editing = editingId === t.id
            return (
              <Group
                key={t.id}
                className="ck-tab"
                data-active={active}
                data-dragging={dragId === t.id || undefined}
                data-drop={drop?.id === t.id ? (drop.after ? 'after' : 'before') : undefined}
                draggable={!editing}
                onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('application/x-ck-tab', t.id); setDragId(t.id) }}
                onDragOver={(e) => {
                  if (!dragId) return
                  e.preventDefault()
                  const r = e.currentTarget.getBoundingClientRect()
                  const after = e.clientX > r.left + r.width / 2
                  if (drop?.id !== t.id || drop.after !== after) setDrop({ id: t.id, after })
                }}
                onDrop={(e) => { e.preventDefault(); if (dragId && drop) onMoveTab(dragId, drop.id, drop.after); endDrag() }}
                onDragEnd={endDrag}
                gap={7}
                wrap="nowrap"
                pl={12}
                pr={editing ? 12 : 6}
                onClick={() => onActivateTab(t.id)}
                onDoubleClick={() => startRename(t.id, label)}
                onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onCloseTab(t.id) } }} // middle-click closes without asking
                style={{ height: '100%', flex: 'none' }}
              >
                <KindIcon kind={t.kind} />
                {editing ? (
                  <TextInput
                    value={draft}
                    onChange={(e) => setDraft(e.currentTarget.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') setEditingId(null) }}
                    onClick={(e) => e.stopPropagation()}
                    autoFocus
                    variant="unstyled"
                    size="xs"
                    styles={{ input: { height: 20, minHeight: 20, lineHeight: '20px', width: 96, fontSize: 12 } }}
                  />
                ) : (
                  <Text fz={13} fw={active ? 600 : 500} c={active ? undefined : 'dimmed'} maw={200} truncate title={`${label} · double-click to rename`}>{label}</Text>
                )}
                {!editing && (
                  <CloseConfirm opened={confirmId === t.id} onChange={(o) => setConfirmId(o ? t.id : null)} label="Close tab" size={16}>
                    <Stack gap="xs">
                      <Text size="sm">Close <b>{label}</b>? Its {k.label} session ends.</Text>
                      <Group justify="flex-end" gap="xs">
                        <Button variant="default" size="xs" onClick={() => setConfirmId(null)}>Cancel</Button>
                        <Button color="red" size="xs" data-autofocus onClick={() => { setConfirmId(null); onCloseTab(t.id) }}>Close tab</Button>
                      </Group>
                    </Stack>
                  </CloseConfirm>
                )}
              </Group>
            )
          })}

          <Menu position="bottom-start" width={172}>
            <Menu.Target>
              <ActionIcon size={26} variant="subtle" color="gray" aria-label="New tab" mx={8} style={{ flex: 'none' }}>
                <span style={{ fontSize: 16, lineHeight: 1 }}>+</span>
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>New tab</Menu.Label>
              <Menu.Item leftSection={<KindIcon kind="claude" />} onClick={() => onAddTab('claude')}>
                claude <Text span c="dimmed" size="xs">· orchestrated</Text>
              </Menu.Item>
              <Menu.Item leftSection={<KindIcon kind="codex" />} onClick={() => onAddTab('codex')}>
                codex <Text span c="dimmed" size="xs">· manual</Text>
              </Menu.Item>
              <Menu.Item leftSection={<KindIcon kind="shell" />} onClick={() => onAddTab('shell')}>
                terminal <Text span c="dimmed" size="xs">· shell</Text>
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>

        <Group gap={2} px={6} wrap="nowrap" style={{ flex: 'none' }}>
          <Tooltip label="Open in VS Code" openDelay={400} withArrow>
            <ActionIcon variant="subtle" color="gray" size="md" onClick={() => openFolder(space.cwd, 'editor')} aria-label="Open in VS Code">
              <IconBrandVscode size={17} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={`Reveal in ${FILE_MANAGER}`} openDelay={400} withArrow>
            <ActionIcon variant="subtle" color="gray" size="md" onClick={() => openFolder(space.cwd, 'files')} aria-label={`Reveal in ${FILE_MANAGER}`}>
              <IconFolderOpen size={17} />
            </ActionIcon>
          </Tooltip>
          {panel && (
            <Tooltip label={panelOpen ? 'Hide git panel' : 'Show git panel'} openDelay={400} withArrow>
              <ActionIcon variant="subtle" color="gray" size="md" onClick={onTogglePanel} aria-label="Toggle git panel">
                {panelOpen ? <IconLayoutSidebarRightCollapse size={17} /> : <IconLayoutSidebarRightExpand size={17} />}
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      </Group>

      <div className="ck-split" style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
          {!space.tabs.length && (
            <DancingJeeves active={spaceActive} />
          )}
          {space.tabs.map((t) => (
            <div key={t.id} style={{ position: 'absolute', inset: 0, display: t.id === space.activeTabId ? 'block' : 'none' }}>
              <TerminalPane sid={`${space.id}:${t.id}`} cwd={space.cwd} cmd={t.kind} active={spaceActive && t.id === space.activeTabId} onTitle={(title) => setLiveTitle(t.id, cleanTitle(title))} />
            </div>
          ))}
        </div>
        {panel && panelOpen && <SpacePanel cwd={space.cwd} repoId={space.repoId || undefined} active={spaceActive} />}
      </div>
    </div>
  )
}

// Shown in a space with no tabs: Jeeves, delighted to have nothing to do, dancing.
// Every frame is padded to the same size so the centred block doesn't jitter.
const DANCE = [
String.raw`
            _.------._            
          .'          '.          
         /   __    __   \         
        |    ^     ^     |        
        |        <       |        
     o   \     \___/    /         
      \   '._        _.'          
       \     |      |             
        \ ___/\    /\___          
         /   \ \/\/ /   \         
        |     \ () /     |\       
        |       ()       | \      
        |       ()       |  o     
        |________________|        
          |     ||     |          
          |     | \     \         
          |     |  \     \_____   
        __|     |   '--._______)  
        (_______)                 `,
String.raw`
            _.------._            
          .'          '.          
         /   __    __   \         
        |    ^     ^     |        
        |        <       |        
         \     \___/    /         
          '._        _.'          
             |      |             
          ___/\    /\___          
     o___/   \ \/\/ /   \___o     
        |     \ () /     |        
        |       ()       |        
        |       ()       |        
        |________________|        
          |     ||     |          
          |     ||     |          
          |     ||     |          
        __|     ||     |__        
        (_______)(_______)        `,
String.raw`
            _.------._            
          .'          '.          
         /   __    __   \         
        |    ^     ^     |        
        |        <       |        
         \     \___/    /   o     
          '._        _.'   /      
             |      |     /       
          ___/\    /\___ /        
         /   \ \/\/ /   \         
       /|     \ () /     |        
      / |       ()       |        
     o  |       ()       |        
        |________________|        
          |     ||     |          
         /     / |     |          
   _____/     /  |     |          
  (_______.--'   |     |__        
                 (_______)        `,
String.raw`
            _.------._            
          .'          '.          
         /   __    __   \         
        |    ^     ^     |        
        |        <       |        
         \     \___/    /         
          '._        _.'          
             |      |             
          ___/\    /\___          
     o___/   \ \/\/ /   \___o     
        |     \ () /     |        
        |       ()       |        
        |       ()       |        
        |________________|        
          |     ||     |          
          |     ||     |          
          |     ||     |          
        __|     ||     |__        
        (_______)(_______)        `
]

function DancingJeeves({ active }: { active: boolean }) {
  const [i, setI] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setI((n) => (n + 1) % DANCE.length), 380)
    return () => clearInterval(t)
  }, [active])
  return (
    <Text component="pre" c="dimmed" ff="monospace" pt={48} fz={22} lh={1.2} style={{ margin: '0 auto', width: 'fit-content', whiteSpace: 'pre' }}>{DANCE[i]}</Text>
  )
}
