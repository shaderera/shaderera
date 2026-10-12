import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Manifest } from '@shaderera/core'
import type { Child } from '../node/child.ts'
import { checkChild } from './check.ts'

test('a check of fewer than two timestamps is refused: it could never fail', async () => {
  const manifest = { fps: 30, duration: 2, width: 4, height: 4 } as Manifest
  for (const times of [0, 1, Number.NaN, 2.5])
    await assert.rejects(checkChild({} as Child, manifest, { times }), /2 or more/)
})
