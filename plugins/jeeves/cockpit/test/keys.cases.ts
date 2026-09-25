// Cases for src/keys.ts (the keys the page-wide handler forwards to a terminal).
// Bundled and run by cases.test.mjs.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { altArrowBytes, globalKeyBytes } from '../src/keys'

const k = (key: string, mods: { alt?: boolean; ctrl?: boolean; meta?: boolean } = {}) =>
  ({ key, altKey: !!mods.alt, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, isComposing: false })

test('printable keys, Enter, Backspace and arrows are forwarded', () => {
  assert.equal(globalKeyBytes(k('a'), false, false), 'a')
  assert.equal(globalKeyBytes(k('A'), false, false), 'A')
  assert.equal(globalKeyBytes(k(' '), false, false), ' ')
  assert.equal(globalKeyBytes(k('Enter'), false, false), '\r')
  assert.equal(globalKeyBytes(k('Backspace'), false, false), '\x7f')
  assert.equal(globalKeyBytes(k('ArrowUp'), false, false), '\x1b[A')
  assert.equal(globalKeyBytes(k('ArrowLeft'), true, false), '\x1bOD')
})

test('keys with no mapping are left to the browser', () => {
  for (const key of ['F5', 'F11', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Shift', 'Dead', 'Unidentified'])
    assert.equal(globalKeyBytes(k(key), false, false), null, key)
})

test('Tab, Shift+Tab and Escape are never forwarded', () => {
  assert.equal(globalKeyBytes(k('Tab'), false, false), null)
  assert.equal(globalKeyBytes(k('Tab'), false, true), null) // Shift+Tab: key is still 'Tab'
  assert.equal(globalKeyBytes(k('Escape'), false, false), null)
  assert.equal(globalKeyBytes(k('Escape'), false, true), null)
})

test('chords are the browser\'s: Alt, Ctrl and Meta', () => {
  assert.equal(globalKeyBytes(k('ArrowLeft', { alt: true }), false, false), null)
  assert.equal(globalKeyBytes(k('p', { ctrl: true }), false, false), null)
  assert.equal(globalKeyBytes(k('p', { meta: true }), false, false), null)
  assert.equal(globalKeyBytes({ ...k('a'), isComposing: true }, false, false), null)
})

test('on a button or link, Enter and Space keep their native meaning', () => {
  assert.equal(globalKeyBytes(k('Enter'), false, true), null)
  assert.equal(globalKeyBytes(k(' '), false, true), null)
  assert.equal(globalKeyBytes(k('x'), false, true), 'x')
})

test('Alt+Arrow is a word jump: ESC b/f on macOS, Ctrl+Arrow elsewhere', () => {
  const a = (key: string, mods: { shift?: boolean; ctrl?: boolean } = {}) =>
    ({ ...k(key, { alt: true, ctrl: mods.ctrl }), shiftKey: !!mods.shift })
  assert.equal(altArrowBytes(a('ArrowLeft'), true), '\x1bb')
  assert.equal(altArrowBytes(a('ArrowRight'), true), '\x1bf')
  assert.equal(altArrowBytes(a('ArrowUp'), true), null)
  assert.equal(altArrowBytes(a('ArrowLeft'), false), '\x1b[1;5D')
  assert.equal(altArrowBytes(a('ArrowDown'), false), '\x1b[1;5B')
  assert.equal(altArrowBytes(a('ArrowLeft', { shift: true }), true), null)
  assert.equal(altArrowBytes(a('ArrowLeft', { ctrl: true }), false), null)
  assert.equal(altArrowBytes({ ...k('ArrowLeft'), shiftKey: false }, true), null)
  assert.equal(altArrowBytes(a('b'), true), null)
})
