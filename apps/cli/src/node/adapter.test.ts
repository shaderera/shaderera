import assert from 'node:assert/strict'
import { test } from 'node:test'
import { errorFinding } from '../cli/findings.ts'
import { adapterLine, refuseSoftware, softwareAdapter } from './adapter.ts'
import { memoryChild } from './fixtures/memory-child.ts'

// Adapters as they answered here: Dawn (webgpu 0.6.2) on Windows, its default and its WARP
// (`adapter=Basic`), and Chrome 156 headless, its default and its `forceFallbackAdapter` one.
const dawnGpu = {
  vendor: 'nvidia',
  architecture: 'blackwell',
  device: 'nvidia-geforce-rtx-5070-ti',
  description: 'D3D12 driver version 32.0.16.1714',
  isFallbackAdapter: false,
}
const dawnWarp = {
  vendor: 'microsoft',
  architecture: 'warp',
  device: 'microsoft-basic-render-driver',
  description: 'D3D12 driver version 10.0.26100.9711',
  isFallbackAdapter: true,
}
const chromeGpu = {
  vendor: 'nvidia',
  architecture: 'blackwell',
  device: '',
  description: '',
  isFallbackAdapter: false,
}
const chromeSwiftShader = {
  vendor: 'google',
  architecture: 'swiftshader',
  device: '',
  description: '',
  isFallbackAdapter: true,
}

test('softwareAdapter tells a hardware GPU from the software renderers WebGPU falls back to', () => {
  assert.equal(softwareAdapter(dawnGpu), undefined)
  assert.equal(softwareAdapter(chromeGpu), undefined)
  assert.equal(softwareAdapter(dawnWarp), 'WARP (Microsoft Basic Render Driver)')
  assert.equal(softwareAdapter(chromeSwiftShader), 'SwiftShader')
  // Not measured here (no Linux machine): the device names Mesa's lavapipe (Vulkan) and
  // SwiftShader's Vulkan driver give themselves, and the D3D adapter WARP is.
  assert.equal(
    softwareAdapter({ vendor: 'mesa', device: 'llvmpipe (LLVM 15.0.7, 256 bits)' }),
    'llvmpipe',
  )
  assert.equal(
    softwareAdapter({ device: 'SwiftShader Device (Subzero) (0x0000C0DE)' }),
    'SwiftShader',
  )
  assert.equal(
    softwareAdapter({ description: 'Microsoft Basic Render Driver' }),
    'WARP (Microsoft Basic Render Driver)',
  )
  // Named nothing known, but the fallback adapter all the same.
  assert.equal(softwareAdapter({ vendor: 'x', isFallbackAdapter: true }), 'a fallback adapter')
})

test('adapterLine is the adapter as capture records keep it', () => {
  assert.equal(adapterLine(dawnGpu), 'nvidia blackwell D3D12 driver version 32.0.16.1714')
  assert.equal(adapterLine(chromeSwiftShader), 'google swiftshader')
})

test('refuseSoftware refuses a host on a software adapter unless accepted, and says so', async () => {
  const size = { width: 8, height: 8 }
  await refuseSoftware(memoryChild({ size }), false)
  const child = memoryChild({
    size,
    identity: { host: 'browser', adapter: 'google swiftshader', software: 'SwiftShader' },
  })
  await assert.rejects(refuseSoftware(child, false), (e: Error) => {
    assert.match(
      e.message,
      /browser host's WebGPU adapter is software, SwiftShader \(google swiftshader\).*--software-gpu/,
    )
    // --json reports it as the machine's lack, as a missing ffmpeg.
    assert.equal(errorFinding(e).code, 'environment')
    return true
  })
  const write = process.stderr.write
  let said = ''
  process.stderr.write = ((s: string) => {
    said += s
    return true
  }) as typeof process.stderr.write
  try {
    await refuseSoftware(child, true)
  } finally {
    process.stderr.write = write
  }
  assert.match(said, /^The browser host's WebGPU adapter is software, SwiftShader/)
})
