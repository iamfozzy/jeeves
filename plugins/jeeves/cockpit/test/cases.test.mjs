// The pure client modules (src/ptyLink.ts, src/keys.ts): each test/*.cases.ts,
// bundled with esbuild and registered on import.
import { after } from 'node:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'jeeves-cases-'))
after(() => rmSync(tmp, { recursive: true, force: true }))
const cases = readdirSync(join(ROOT, 'test')).filter((f) => f.endsWith('.cases.ts'))
await build({ entryPoints: cases.map((f) => join(ROOT, 'test', f)), bundle: true, platform: 'node', format: 'esm', outdir: tmp, outExtension: { '.js': '.mjs' }, logLevel: 'error' })
for (const f of cases) await import(pathToFileURL(join(tmp, f.replace(/\.ts$/, '.mjs'))).href)
