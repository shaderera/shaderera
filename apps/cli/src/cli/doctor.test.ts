import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { tempDir } from '../fixtures/temp.ts'
import { gpuItem, hdr10Item, limitsLine, shareItem, signInItem } from './doctor.ts'
import { saveToken } from './site.ts'

test('limitsLine names the limits films run into, in MB and pixels', () => {
  assert.equal(
    limitsLine({
      maxBufferSize: 2 ** 31,
      maxStorageBufferBindingSize: 2 ** 27,
      maxTextureDimension2D: 16384,
      maxTextureArrayLayers: 2048,
    }),
    'buffers to 2048 MB, storage binding 128 MB, textures to 16384 px, 2048 layers',
  )
})

test('doctor warns on a software adapter, says what to check, and passes a GPU', () => {
  const swiftShader = gpuItem('browser', {
    vendor: 'google',
    architecture: 'swiftshader',
    device: '',
    description: '',
    isFallbackAdapter: true,
  })
  assert.equal(swiftShader.status, 'warn')
  assert.equal(swiftShader.detail, 'software, SwiftShader: google swiftshader (browser host)')
  assert.match(swiftShader.fix ?? '', /--software-gpu.*driver.*--disable-gpu/)
  const warp = gpuItem(
    'node',
    {
      vendor: 'microsoft',
      architecture: 'warp',
      device: 'microsoft-basic-render-driver',
      description: 'D3D12 driver version 10.0.26100.9711',
      isFallbackAdapter: true,
    },
    { features: ['float32-filterable'], limits: { maxTextureDimension2D: 16384 } },
  )
  assert.equal(warp.status, 'warn')
  assert.match(
    warp.detail,
    /^software, WARP \(Microsoft Basic Render Driver\): microsoft warp D3D12/,
  )
  assert.match(warp.fix ?? '', /Vulkan ICD/)
  assert.deepEqual(warp.limits, { maxTextureDimension2D: 16384 })
  assert.deepEqual(gpuItem('browser', { vendor: 'nvidia', architecture: 'blackwell' }), {
    id: 'gpu',
    status: 'ok',
    detail: 'nvidia blackwell (browser host)',
    needed: true,
  })
  assert.equal(gpuItem('node', null).status, 'missing')
})

test('doctor says whether this machine is signed in, as whom, and whether the project can be shared', async () => {
  const home = tempDir('doctor-home')
  const was = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  const server = createServer((req, res) => {
    const ok = req.url === '/api/v1/auth/me' && req.headers.authorization === 'Bearer sha_live'
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify(
        ok
          ? { handle: 'ana', name: 'studio-mac', expiresAt: Date.UTC(2027, 0, 19) }
          : { error: 'A valid token is needed.' },
      ),
    )
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    assert.deepEqual(await signInItem(api), {
      id: 'sign-in',
      needed: false,
      status: 'warn',
      detail: `not signed in to ${api}`,
      fix: `Sign in: npx shaderera login --api ${api}`,
    })
    saveToken(api, 'sha_live')
    const signed = await signInItem(api)
    assert.equal(signed.status, 'ok')
    assert.equal(signed.detail, `ana on ${api} (this machine as "studio-mac", until 2027-01-19)`)
    saveToken(api, 'sha_gone')
    assert.match((await signInItem(api)).detail, /no longer signed in/)
    saveToken('http://127.0.0.1:1', 'sha_kept')
    assert.match(
      (await signInItem('http://127.0.0.1:1')).detail,
      /not checked: .*cannot be reached/,
    )
  } finally {
    server.close()
    Object.assign(process.env, was)
  }

  const root = tempDir('doctor-share')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ license: 'UNLICENSED' }))
  assert.deepEqual(shareItem(root), {
    id: 'share',
    status: 'ok',
    detail: 'licence All rights reserved',
    needed: false,
  })
  writeFileSync(join(root, 'package.json'), JSON.stringify({}))
  assert.equal(shareItem(root).status, 'warn')
  assert.match(shareItem(root).detail, /no licence/)
})

test('doctor says whether ffmpeg can make HDR10: 9.0 or later, SDR on older', () => {
  const old = hdr10Item(
    'HDR10 needs ffmpeg 9.0 or later (for -mastering_display and -content_light); this is ffmpeg version 8.1.1. SDR renders work on it.',
    false,
  )
  assert.equal(old.status, 'warn')
  assert.equal(old.needed, false)
  assert.match(old.fix ?? '', /ffmpeg 9\.0/)
  const ok = hdr10Item(undefined, true)
  assert.equal(ok.status, 'ok')
  assert.match(ok.detail, /ffmpeg 9\.0 or later.*NVIDIA HEVC/)
})
