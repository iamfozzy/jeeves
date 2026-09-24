import { useState } from 'react'
import { SegmentedControl } from '@mantine/core'
import { TerminalPane } from './TerminalPane'
import { Dashboard } from './Dashboard'
import type { Reminder, RepoCfg, Surface, WorkerSpace } from './types'

// Left: the real orchestrator claude session in the neutral home (repo-agnostic),
// booted as `orch` so the backend wires it to the cockpit MCP + a known session id.
// Right: the dashboard the orchestrator paints via surface.render.
// Below the sm breakpoint the two stack as one pane with a switch between them.
export function OrchestratorView({
  home,
  repos,
  surface,
  workers,
  reminders,
  active
}: {
  home: string
  repos: RepoCfg[]
  surface: Surface
  workers: WorkerSpace[]
  reminders: Reminder[]
  active: boolean
}) {
  const [pane, setPane] = useState<'terminal' | 'dashboard'>('terminal')
  return (
    <div className="ck-orch" data-pane={pane} style={{ height: '100%', display: 'flex', minHeight: 0 }}>
      <SegmentedControl hiddenFrom="sm" fullWidth size="xs" radius={0} value={pane} onChange={(v) => setPane(v as typeof pane)}
        data={[{ value: 'terminal', label: 'Jeeves' }, { value: 'dashboard', label: 'Dashboard' }]} />
      <div className="ck-orch-term" style={{ flex: 1, minWidth: 0, borderRight: '1px solid var(--ck-border)' }}>
        <TerminalPane sid="orch:main" cwd={home} cmd="orch" active={active} />
      </div>
      <div className="ck-orch-dash" style={{ width: 400, flex: 'none', overflowY: 'auto', background: 'var(--ck-surface)' }}>
        <Dashboard repos={repos} surface={surface} workers={workers} reminders={reminders} />
      </div>
    </div>
  )
}
