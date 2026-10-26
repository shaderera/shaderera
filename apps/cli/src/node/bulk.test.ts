import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { bulkReader } from './bulk.ts'

const bytes = (n: number, from: number) =>
  Uint8Array.from({ length: n }, (_, i) => (from + i) % 256)

test('payloads come off the pipe in the order announced, whatever the pieces the pipe gives', async () => {
  const pipe = new PassThrough()
  const bulk = bulkReader(pipe)
  const a = bytes(5, 0)
  const b = bytes(7, 100)
  // Announced before any byte came, then the bytes in pieces that straddle the two payloads.
  const first = bulk.next(a.length)
  pipe.write(a.subarray(0, 3))
  pipe.write(Buffer.concat([a.subarray(3), b.subarray(0, 2)]))
  const second = bulk.next(b.length)
  pipe.write(b.subarray(2))
  assert.deepEqual(await first, a)
  assert.deepEqual(await second, b)
  // Bytes that came before their announcement wait for it.
  pipe.write(bytes(4, 50))
  await new Promise((done) => setImmediate(done))
  assert.deepEqual(await bulk.next(4), bytes(4, 50))
})

test('a payload not fully come when the pipe closes fails', async () => {
  const pipe = new PassThrough()
  const bulk = bulkReader(pipe)
  const waiting = bulk.next(10)
  pipe.write(bytes(4, 0))
  pipe.destroy()
  await assert.rejects(waiting, /exited/)
  await assert.rejects(bulk.next(1), /exited/)
})
