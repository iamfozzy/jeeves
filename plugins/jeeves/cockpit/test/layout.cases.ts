// Cases for the pure layout/view decisions in src/types.ts. Bundled and run by
// cases.test.mjs, same as ptyLink.cases.ts and keys.cases.ts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyOwnActiveTabs, mergeLocalSpaces, resolveActiveSpaceId, stripActiveTabs } from '../src/types'
import type { Space, WorkerSpace } from '../src/types'

const space = (id: string, activeTabId = 't1'): Space => ({ id, repoId: '', name: id, cwd: '/' + id, tabs: [{ id: activeTabId, kind: 'shell' }], activeTabId })
const worker = (workId: string): WorkerSpace => ({
  workId, sid: 's:' + workId, agent: 'story-worker', repo: 'r', repoSlug: 'r', ticket: null, branch: 'b',
  cwd: '/w', status: 'working', summary: null, pr: null, createdAt: 0, updatedAt: 0
})

test('resolveActiveSpaceId', async (t) => {
  await t.test('leaves non-work views alone regardless of workers', () => {
    assert.equal(resolveActiveSpaceId('orch', [], true, 'orch'), 'orch')
    assert.equal(resolveActiveSpaceId('scratch', [], true, 'orch'), 'scratch')
    assert.equal(resolveActiveSpaceId('some-space-id', [], true, 'orch'), 'some-space-id')
  })
  await t.test('keeps a work: view before the first spaces message (no guessing)', () => {
    assert.equal(resolveActiveSpaceId('work:abc', [], false, 'orch'), 'work:abc')
  })
  await t.test('keeps a work: view once its worker is confirmed present', () => {
    assert.equal(resolveActiveSpaceId('work:abc', [worker('abc'), worker('def')], true, 'orch'), 'work:abc')
  })
  await t.test('falls back once the first spaces message confirms it is gone', () => {
    assert.equal(resolveActiveSpaceId('work:abc', [worker('def')], true, 'orch'), 'orch')
    assert.equal(resolveActiveSpaceId('work:abc', [], true, 'orch'), 'orch')
  })
})

test('mergeLocalSpaces', async (t) => {
  await t.test('keeps only the local spaces the server layout does not have', () => {
    const mine = [space('a'), space('b'), space('c')]
    const server = [space('b')]
    assert.deepEqual(mergeLocalSpaces(mine, server).map((s) => s.id), ['a', 'c'])
  })
  await t.test('nothing local-only leaves nothing to merge', () => {
    assert.deepEqual(mergeLocalSpaces([space('a')], [space('a')]), [])
  })
  await t.test('an empty server layout keeps every local space', () => {
    assert.deepEqual(mergeLocalSpaces([space('a'), space('b')], []).map((s) => s.id), ['a', 'b'])
  })
})

test('applyOwnActiveTabs', async (t) => {
  await t.test('overrides activeTabId for a space this browser has chosen a tab in', () => {
    const [s] = applyOwnActiveTabs([space('a', 'server-tab')], { a: 'mine-tab' })
    assert.equal(s.activeTabId, 'mine-tab')
  })
  await t.test('leaves a space with no local choice on the incoming value', () => {
    const [s] = applyOwnActiveTabs([space('a', 'server-tab')], {})
    assert.equal(s.activeTabId, 'server-tab')
    const [s2] = applyOwnActiveTabs([space('a', 'server-tab')], { b: 'mine-tab' })
    assert.equal(s2.activeTabId, 'server-tab')
  })
})

test('stripActiveTabs', async (t) => {
  await t.test('blanks activeTabId, keeps everything else', () => {
    const [s] = stripActiveTabs([space('a', 'some-tab')])
    assert.equal(s.activeTabId, '')
    assert.equal(s.id, 'a')
    assert.deepEqual(s.tabs, [{ id: 'some-tab', kind: 'shell' }])
  })
  await t.test('two spaces that only differ by which tab is active strip to the same shape', () => {
    const base = space('x', 'tab1')
    const twoTabs = { ...base, tabs: [{ id: 'tab1', kind: 'shell' as const }, { id: 'tab2', kind: 'shell' as const }] }
    const a = JSON.stringify(stripActiveTabs([{ ...twoTabs, activeTabId: 'tab1' }]))
    const b = JSON.stringify(stripActiveTabs([{ ...twoTabs, activeTabId: 'tab2' }]))
    assert.equal(a, b)
  })
})
