// The terminal pane's connection state machine (src/ptyLink.ts): the cases in
// ptyLink.cases.ts, bundled with esbuild and registered on import.
import { after } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'jeeves-ptylink-'))
after(() => rmSync(tmp, { recursive: true, force: true }))
const outfile = join(tmp, 'cases.mjs')
await build({ entryPoints: [join(ROOT, 'test', 'ptyLink.cases.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error' })
await import(pathToFileURL(outfile).href)
