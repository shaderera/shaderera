import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { cmapCodePoints, missingGlyphs } from './cmap.ts'

const font = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../node/fixtures/dom/src/fonts/${name}`, import.meta.url)))

test('cmapCodePoints reads a shipped Latin font and a Thai font', () => {
  const latin = cmapCodePoints(font('NotoSans-Regular.ttf'))
  assert.ok(latin.has('A'.codePointAt(0) as number))
  assert.ok(latin.has('é'.codePointAt(0) as number))
  assert.ok(!latin.has('ก'.codePointAt(0) as number))
  const thai = cmapCodePoints(font('NotoSansThai-Regular.ttf'))
  assert.ok(thai.has('ก'.codePointAt(0) as number))
  assert.deepEqual(missingGlyphs('Hello ฝน', latin), ['ฝ', 'น'])
  assert.deepEqual(missingGlyphs('ฝน ตีห้า', thai), [])
})
