// Make node-pty's spawn-helper executable (npm can drop the bit on macOS/Linux).
// Windows has no spawn-helper and no chmod; nothing to do. Never fails the install.
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

if (process.platform !== 'win32') {
  const dir = join('node_modules', 'node-pty', 'prebuilds')
  try {
    for (const p of readdirSync(dir)) {
      const f = join(dir, p, 'spawn-helper')
      try { if (existsSync(f)) chmodSync(f, 0o755) } catch {}
    }
  } catch {}
}
