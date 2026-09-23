import ReactDOM from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import '@mantine/core/styles.css'
import '@xterm/xterm/css/xterm.css'
import './index.css'
import { theme } from './theme'
import { App } from './App'

// No StrictMode: it double-mounts effects in dev, which fights xterm's single
// open()/dispose() lifecycle. The Terminal effect cleans up on its own.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <MantineProvider theme={theme} defaultColorScheme="dark">
    <App />
  </MantineProvider>
)
