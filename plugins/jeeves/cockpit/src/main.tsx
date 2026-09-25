import { Component, type ReactNode } from 'react'
import ReactDOM from 'react-dom/client'
import { MantineProvider, v8CssVariablesResolver } from '@mantine/core'
import '@mantine/core/styles.css'
import '@xterm/xterm/css/xterm.css'
import './index.css'
import { theme } from './theme'
import { App } from './App'

// A render error anywhere in the tree (a bad server payload, a third-party
// component throwing) would otherwise blank the whole page with nothing but a
// console trace. Catch it here and offer a reload instead.
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, fontFamily: 'system-ui, sans-serif', color: '#d6dce4', background: '#0d0c11' }}>
        <div style={{ fontSize: 14 }}>Something went wrong: {this.state.error.message}</div>
        <button onClick={() => location.reload()} style={{ font: 'inherit', padding: '6px 14px', borderRadius: 6, border: '1px solid #444', background: '#211f26', color: 'inherit', cursor: 'pointer' }}>Reload</button>
      </div>
    )
  }
}

// No StrictMode: it double-mounts effects in dev, which fights xterm's single
// open()/dispose() lifecycle. The Terminal effect cleans up on its own.
// The v8 resolver keeps the translucent `light` variant (Badge, Alert, Button)
// that the palette was tuned against.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <MantineProvider theme={theme} defaultColorScheme="dark" cssVariablesResolver={v8CssVariablesResolver}>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </MantineProvider>
)
