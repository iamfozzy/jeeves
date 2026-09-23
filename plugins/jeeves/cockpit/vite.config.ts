import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The React UI runs on Vite (5173) with HMR; the PTY/WebSocket backend runs on
// server.mjs (4177). Vite proxies the /pty socket through to it so the browser
// only ever talks to one origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4177',
      '/mcp': 'http://localhost:4177',
      '/pty': { target: 'ws://localhost:4177', ws: true },
      '/events': { target: 'ws://localhost:4177', ws: true }
    }
  },
  build: { outDir: 'dist' }
})
