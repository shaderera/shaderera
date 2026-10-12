import assert from 'node:assert/strict'
import { test } from 'node:test'
import { paramDefaults } from './params.ts'

const base = { entry: './a.ts', fps: 30, duration: 1, width: 2, height: 2 }

test('paramDefaults takes each property default from the schema', () => {
  const manifest = {
    ...base,
    params: {
      type: 'object',
      properties: { speed: { type: 'number', default: 2 }, title: { type: 'string' } },
    },
  }
  assert.deepEqual(paramDefaults(manifest), { speed: 2 })
})

test('paramDefaults is empty without params', () => {
  assert.deepEqual(paramDefaults(base), {})
})
