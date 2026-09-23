import { useEffect, useState } from 'react'
import { TOKEN } from './token'
import type { Layout, OpenSpaceCmd, OrchContext, SpaceCmd, Surface, WorkerSpace } from './types'

const rid = () => Math.random().toString(36).slice(2, 8)
// This browser's id: layout saves carry it, so the server's echo of our own save is skipped.
export const CLIENT_ID = rid() + rid()

// The browser half of the control plane: one WebSocket to /events that receives
// the surface the orchestrator paints, the dispatched worker spaces, and the
// orchestrator's live context usage, and the shared layout. Reconnects on drop.
export function useCockpitEvents() {
  const [surface, setSurface] = useState<Surface>(null)
  const [workers, setWorkers] = useState<WorkerSpace[]>([])
  const [context, setContext] = useState<OrchContext | null>(null)
  // Lifecycle status of user-opened claude tabs, keyed by sid (`spaceId:tabId`).
  const [sessions, setSessions] = useState<Record<string, string>>({})
  // Bumped when project config changes server-side, so the app refetches /api/config.
  const [configNonce, setConfigNonce] = useState(0)
  // Open-space commands from the orchestrator; App consumes new ids and drops old.
  const [openCmds, setOpenCmds] = useState<OpenSpaceCmd[]>([])
  // add_tab / close_space commands targeting an open space (by spaceRef or id).
  const [spaceCmds, setSpaceCmds] = useState<SpaceCmd[]>([])
  // The shared layout, when another browser saved it.
  const [remoteLayout, setRemoteLayout] = useState<Layout | null>(null)

  useEffect(() => {
    let stop = false
    let ws: WebSocket | null = null
    let retry: number | undefined
    let delay = 1000 // backoff so a bad state (e.g. no token) doesn't hammer

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const qs = TOKEN ? '?token=' + encodeURIComponent(TOKEN) : ''
      ws = new WebSocket(`${proto}://${location.host}/events${qs}`)
      ws.onopen = () => { delay = 1000 }
      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(e.data as string)
          if (m.t === 'surface') setSurface(m.payload ?? null)
          else if (m.t === 'spaces') setWorkers(m.spaces || [])
          else if (m.t === 'context') setContext(m.ctx ?? null)
          else if (m.t === 'sessions') setSessions(m.statuses || {})
          else if (m.t === 'sessionStatus') setSessions((prev) => ({ ...prev, [m.sid]: m.status }))
          else if (m.t === 'config') setConfigNonce((n) => n + 1)
          else if (m.t === 'layout' && m.layout && m.from !== CLIENT_ID) setRemoteLayout(m.layout)
          else if (m.t === 'open_space' && m.cmd) setOpenCmds((prev) => [...prev.slice(-19), m.cmd])
          else if ((m.t === 'add_tab' || m.t === 'close_space') && (m.spaceRef || m.spaceId))
            setSpaceCmds((prev) => [...prev.slice(-19), { id: rid(), t: m.t, spaceRef: m.spaceRef, spaceId: m.spaceId, kind: m.kind, tab: m.tab, open: m.open }])
        } catch {}
      }
      ws.onclose = () => {
        if (stop) return
        retry = window.setTimeout(connect, delay)
        delay = Math.min(delay * 2, 15000)
      }
    }
    connect()

    return () => { stop = true; if (retry) clearTimeout(retry); ws?.close() }
  }, [])

  return { surface, workers, context, sessions, configNonce, openCmds, spaceCmds, remoteLayout }
}
