import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Child } from './child.ts'
import { memoryChild } from './fixtures/memory-child.ts'
import { frameError, openHosts } from './open-host.ts'

test('a device error names its frame and, with several hosts, fewer --workers', () => {
  const lost = new Error('The WebGPU device was lost (Device removed)')
  assert.match(
    frameError(lost, 2, 30, 4).message,
    /^Frame 60 \(t 2 s\) failed: .*4 hosts \(--workers 4\).*fewer --workers/,
  )
  assert.doesNotMatch(frameError(lost, 2, 30, 1).message, /--workers/)
  assert.equal(
    frameError(new Error('x is undefined'), 2, 30, 4).message,
    'Frame 60 (t 2 s) failed: x is undefined',
  )
})

test('a host that crashed in native code, with several hosts, says fewer --workers', () => {
  for (const code of ['3221226505', 'SIGSEGV'])
    assert.match(
      frameError(new Error(`The source process exited (${code}).`), 2, 30, 2).message,
      /fewer --workers/,
    )
  assert.doesNotMatch(
    frameError(new Error('The source process exited (1).'), 2, 30, 2).message,
    /--workers/,
  )
})

test('a host whose open runs out of GPU memory says fewer --workers only with several hosts', async () => {
  const oom = 'D3D12 create command queue failed with E_OUTOFMEMORY'
  let closed = 0
  // The first host opens; the others fail as the GPU runs out.
  const opener = () => {
    let n = 0
    return async (): Promise<Child> => {
      if (n++ > 0) throw new Error(oom)
      const child = memoryChild({ size: { width: 2, height: 2 } })
      return { ...child, close: async () => void closed++ }
    }
  }
  await assert.rejects(openHosts(opener(), 4), (e: Error) => {
    assert.match(e.message, /E_OUTOFMEMORY 4 hosts \(--workers 4\).*fewer --workers/)
    return true
  })
  assert.equal(closed, 1)
  const failing = async (): Promise<Child> => {
    throw new Error(oom)
  }
  // The first already open, one more to make two.
  await assert.rejects(openHosts(failing, 1, 2), /2 hosts \(--workers 2\).*fewer --workers/)
  await assert.rejects(openHosts(failing, 1), (e: Error) => e.message === oom)
})
