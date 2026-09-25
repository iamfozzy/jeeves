// Cases for the pure layout/view decisions in src/types.ts. Bundled and run by
// cases.test.mjs, same as ptyLink.cases.ts and keys.cases.ts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyOwnActiveTabs, mergeLocalSpaces, pruneActiveTabs, remoteLayoutAction, resolveActiveSpaceId, stripActiveTabs } from '../src/types'
import type { Space, WorkerSpace } from '../src/types'

const space = (id: string, activeTabId = 't1'): Space => ({ id, repoId: '', name: id, cwd: '/' + id, tabs: [{ id: activeTabId, kind: 'shell' }], activeTabId })
const twoTabs = (id: string): Space => ({ ...space(id), tabs: [{ id: 't1', kind: 'shell' }, { id: 't2', kind: 'shell' }] })
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
    const both = { ...space('a', 'server-tab'), tabs: [{ id: 'server-tab', kind: 'shell' as const }, { id: 'mine-tab', kind: 'shell' as const }] }
    const [s] = applyOwnActiveTabs([both], { a: 'mine-tab' })
    assert.equal(s.activeTabId, 'mine-tab')
  })
  await t.test('leaves a space with no local choice on the incoming value', () => {
    const [s] = applyOwnActiveTabs([space('a', 'server-tab')], {})
    assert.equal(s.activeTabId, 'server-tab')
    const [s2] = applyOwnActiveTabs([space('a', 'server-tab')], { b: 'mine-tab' })
    assert.equal(s2.activeTabId, 'server-tab')
  })
  await t.test('ignores a local choice whose tab has closed', () => {
    const [s] = applyOwnActiveTabs([space('a', 'server-tab')], { a: 'gone-tab' })
    assert.equal(s.activeTabId, 'server-tab')
  })
})

test('pruneActiveTabs', async (t) => {
  await t.test('keeps choices whose space and tab still exist, drops the rest', () => {
    const spaces = [twoTabs('a'), space('b', 'b1')]
    assert.deepEqual(pruneActiveTabs({ a: 't2', b: 'gone', c: 't1' }, spaces), { a: 't2' })
  })
})

test('remoteLayoutAction', async (t) => {
  const p = { hasLayout: true, connect: false, saving: false, dirty: false }
  await t.test('no server layout seeds it, connect or not', () => {
    assert.equal(remoteLayoutAction({ ...p, hasLayout: false, connect: true }), 'seed')
    assert.equal(remoteLayoutAction({ ...p, hasLayout: false, saving: true }), 'seed')
  })
  await t.test('keeps local while its own save is in flight (the push predates it)', () => {
    assert.equal(remoteLayoutAction({ ...p, connect: true, saving: true }), 'keep')
    assert.equal(remoteLayoutAction({ ...p, saving: true }), 'keep')
  })
  await t.test('a connect push meeting unsaved local changes keeps them', () => {
    assert.equal(remoteLayoutAction({ ...p, connect: true, dirty: true }), 'keep')
  })
  await t.test("otherwise the server's wins, another browser's save included", () => {
    assert.equal(remoteLayoutAction({ ...p, connect: true }), 'apply')
    assert.equal(remoteLayoutAction({ ...p, dirty: true }), 'apply')
    assert.equal(remoteLayoutAction(p), 'apply')
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
