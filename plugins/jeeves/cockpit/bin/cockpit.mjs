#!/usr/bin/env node
// Jeeves Cockpit launcher. Ensures deps + a current UI build, starts the server,
// and opens the browser at the tokenised URL. Self-locating, so it works the same
// from a plugin cache or a dev checkout. Both `/jeeves:cockpit` and the `jeeves`
// terminal command call this.
import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs'
import { spawnSync, spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platform } from 'node:os'

const root = dirname(dirname(fileURLToPath(import.meta.url))) // bin/ → cockpit root
const args = process.argv.slice(2)
const noOpen = args.includes('--no-open') || process.env.JEEVES_COCKPIT_NO_OPEN === '1'
const forceBuild = args.includes('rebuild') || args.includes('--rebuild')
// shell:true on Windows so `npm` (really npm.cmd) resolves; harmless elsewhere.
const sh = (cmd, a) => spawnSync(cmd, a, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })

// 1. Native deps (node-pty) must be installed on this machine.
if (!existsSync(join(root, 'node_modules', 'node-pty'))) {
  console.log('jeeves cockpit: installing dependencies (first run, ~1 min)…')
  const r = sh('npm', ['ci']); if (r.status) process.exit(r.status)
}

// 2. Build the UI when the bundle is missing or older than any source file.
const distIndex = join(root, 'dist', 'index.html')
function distStale() {
  if (!existsSync(distIndex)) return true
  const built = statSync(distIndex).mtimeMs
  let newest = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else newest = Math.max(newest, statSync(p).mtimeMs)
    }
  }
  walk(join(root, 'src'))
  for (const f of ['index.html', 'vite.config.ts', 'package.json']) {
    const p = join(root, f); if (existsSync(p)) newest = Math.max(newest, statSync(p).mtimeMs)
  }
  return newest > built
}
if (forceBuild || distStale()) {
  console.log('jeeves cockpit: building UI…')
  const r = sh('npm', ['run', 'build']); if (r.status) process.exit(r.status)
}

// 3. Start the server (it prints its URL), then open the browser at it.
const srv = spawn('node', ['server.mjs'], { cwd: root, stdio: 'inherit', env: process.env })
srv.on('exit', (c) => process.exit(c ?? 0))

// Open the browser once the server answers and its token file exists — a first run
// writes the file only after the server's imports load. Gives up waiting after 15 s.
if (!noOpen) (async () => {
  try {
    const port = process.env.PORT || 4177
    let token = process.env.JEEVES_TOKEN || ''
    for (const end = Date.now() + 15000; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) {
      if (!token) { try { token = readFileSync(join(root, '.jeeves-token'), 'utf8').trim() } catch {} }
      if (token && await fetch(`http://localhost:${port}/`).then(() => true, () => false)) break
    }
    const url = `http://localhost:${port}/${token ? '?token=' + encodeURIComponent(token) : ''}`
    // Windows: `explorer <url>` can open File Explorer instead of the browser; hand the
    // URL to the default protocol handler.
    const [opener, oargs] = platform() === 'darwin' ? ['open', [url]]
      : platform() === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]]
    spawnSync(opener, oargs, { stdio: 'ignore' })
  } catch {}
})()
