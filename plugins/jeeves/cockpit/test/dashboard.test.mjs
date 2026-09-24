// Dashboard's Linked component and reminder due-time helpers, bundled from the TSX with esbuild.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'jeeves-dash-'))
let m
before(async () => {
  const outfile = join(tmp, 'dashboard.mjs')
  // One bundle for the component and the renderer, so both share a single React.
  await build({
    stdin: { contents: "export { Linked, dueAt, whenDue } from './src/Dashboard.tsx'\nexport { renderToStaticMarkup } from 'react-dom/server'\nexport { createElement } from 'react'", resolveDir: ROOT, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', outfile, logLevel: 'error',
    loader: { '.css': 'empty' },
    // CommonJS deps bundled into ESM call require() for node builtins.
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" }
  })
  m = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const API = { id: 'api', slug: 'acme/api-server', path: '/x/api', jiraKey: 'ABC', jiraBase: 'https://acme.atlassian.net/browse' }
const WEB = { id: 'web', slug: 'acme/web', path: '/x/web' }
const REPOS = [API, WEB]
// Every link in the markup as [text, href].
const links = (text, repo) => {
  const html = m.renderToStaticMarkup(m.createElement(m.Linked, { text, repo, repos: REPOS }))
  return { html, text: html.replace(/<[^>]+>/g, ''), links: [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g)].map((x) => [x[2], x[1]]) }
}
const gh = (slug, n) => `https://github.com/${slug}/pull/${n}`

test('Linked', async (t) => {
  await t.test('bare #12 links to the row repo', () => {
    assert.deepEqual(links('fix #12 and #13', WEB).links, [['#12', gh('acme/web', 12)], ['#13', gh('acme/web', 13)]])
  })
  await t.test('bare #12 with no row repo stays text', () => {
    const r = links('fix #12', undefined)
    assert.deepEqual(r.links, [])
    assert.equal(r.text, 'fix #12')
  })
  await t.test('api#201 links to a configured repo by id', () => {
    assert.deepEqual(links('see api#201', WEB).links, [['api#201', gh('acme/api-server', 201)]])
  })
  await t.test('api-server#3 links to a configured repo by slug name', () => {
    assert.deepEqual(links('api-server#3', WEB).links, [['api-server#3', gh('acme/api-server', 3)]])
  })
  await t.test('owner/name#7 links directly', () => {
    assert.deepEqual(links('other/thing#7', WEB).links, [['other/thing#7', gh('other/thing', 7)]])
  })
  await t.test('PR#9 keeps PR as text and links #9 to the row repo', () => {
    const r = links('PR#9 is up', WEB)
    assert.deepEqual(r.links, [['#9', gh('acme/web', 9)]])
    assert.match(r.html, /<span>PR<a /)
  })
  await t.test('PR#9 with no row repo is all text', () => {
    const r = links('PR#9', undefined)
    assert.deepEqual(r.links, [])
    assert.equal(r.text, 'PR#9')
  })
  await t.test('Jira keys link when the repo has jiraKey and jiraBase', () => {
    assert.deepEqual(links('ABC-5940: fix #4', API).links, [
      ['ABC-5940', 'https://acme.atlassian.net/browse/ABC-5940'], ['#4', gh('acme/api-server', 4)]
    ])
  })
  await t.test('Jira keys stay text without jiraBase', () => {
    assert.deepEqual(links('ABC-5940', { ...API, jiraBase: null }).links, [])
    assert.deepEqual(links('ABC-5940', WEB).links, [])
  })
  await t.test('text is escaped', () => {
    assert.match(links('<b>x</b> #1', WEB).html, /&lt;b&gt;x&lt;\/b&gt;/)
  })
})

test('whenDue', async (t) => {
  // Freeze "now" at Thu 24 Sep 2026 12:00 local: whenDue reads the current day from new Date().
  const RealDate = globalThis.Date
  const NOW = new RealDate(2026, 8, 24, 12, 0).getTime()
  globalThis.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(NOW) }
    static now() { return NOW }
  }
  t.after(() => { globalThis.Date = RealDate })
  const when = (s) => m.whenDue(s, m.dueAt(s) - NOW)

  await t.test('dueAt parses local stamps and rejects anything else', () => {
    assert.equal(m.dueAt('2026-09-24 12:00'), NOW)
    assert.ok(Number.isNaN(m.dueAt('2026-09-24T12:00')))
    assert.ok(Number.isNaN(m.dueAt('soon')))
  })
  await t.test('overdue in minutes', () => assert.equal(when('2026-09-24 11:40'), 'overdue 20m'))
  await t.test('due right now is overdue 0m', () => assert.equal(when('2026-09-24 12:00'), 'overdue 0m'))
  await t.test('overdue in hours', () => assert.equal(when('2026-09-24 09:00'), 'overdue 3h'))
  await t.test('overdue in days', () => assert.equal(when('2026-09-21 12:00'), 'overdue 3d'))
  await t.test('later today', () => assert.equal(when('2026-09-24 15:00'), 'due today 15:00'))
  await t.test('tomorrow', () => assert.equal(when('2026-09-25 10:00'), 'due tomorrow 10:00'))
  await t.test('late tomorrow', () => assert.equal(when('2026-09-25 23:59'), 'due tomorrow 23:59'))
  await t.test('a later date', () => {
    const day = new RealDate(2026, 8, 30).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
    assert.equal(when('2026-09-30 10:00'), `due ${day} 10:00`)
  })
  await t.test('malformed input falls back to the raw text', () => assert.equal(when('next week'), 'due next week'))
})
