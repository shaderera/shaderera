import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../fixtures/temp.ts'
import { createJob } from '../project/jobs.ts'
import { materialize, releaseFrozen, save } from '../project/revisions.ts'
import {
  binary,
  diskItems,
  gpuItem,
  hdr10Item,
  limitsLine,
  shareItem,
  signInItem,
  studioItem,
} from './doctor.ts'
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

test('doctor says whether the default browser shows the studio, and names Chrome as the fix', () => {
  for (const id of ['ChromeHTML', 'com.google.chrome', 'MSEdgeHTM', 'microsoft-edge.desktop'])
    assert.equal(studioItem(id).status, 'ok', id)
  for (const id of ['com.apple.safari', 'BraveHTML', 'com.brave.browser']) {
    const item = studioItem(id)
    assert.equal(item.status, 'warn', id)
    assert.match(item.detail, /has no preview/)
    assert.match(item.fix ?? '', /Chrome/)
  }
  assert.match(studioItem('firefox.desktop').detail, /Firefox .*untested/)
  assert.equal(studioItem(undefined).status, 'warn')
  assert.equal(studioItem('ChromeHTML').needed, false)
})

test('binary prints bytes in binary units', () => {
  assert.equal(binary(0), '0 B')
  assert.equal(binary(1023), '1023 B')
  assert.equal(binary(1024), '1.0 KiB')
  assert.equal(binary(1.5 * 2 ** 20), '1.5 MiB')
  assert.equal(binary(2 * 2 ** 30), '2.0 GiB')
})

test('doctor says what takes the project’s disk space, what prune would free and what pins the biggest objects', async () => {
  const root = join(tempDir('doctor-disk'), 'film')
  cpSync(fileURLToPath(new URL('fixtures/mcp/', import.meta.url)), root, { recursive: true })
  const put = (path: string, bytes: number, fill = 1) => {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), Buffer.alloc(bytes, fill))
  }
  put('assets/clip.bin', 3 * 2 ** 20)
  const start = save(root, { by: 'cli', label: 'start' }).id
  await createJob(root, { by: 'cli', revision: start, name: 'j1' })
  put('assets/music.bin', 2 * 2 ** 20)
  // 11 saves past the labelled one: prune keeps the last 10, so the first goes with its object.
  for (let i = 0; i < 11; i++) {
    put('note.bin', 100, i + 2)
    save(root, { by: 'cli' })
  }
  const old = new Date(Date.now() - 24 * 3600_000)
  const objects = join(root, 'versions', 'objects')
  for (const o of readdirSync(objects)) utimesSync(join(objects, o), old, old)
  materialize(root, start)
  releaseFrozen(root, start)
  put('.shaderera/cache/bundle.js', 4000)
  put('out/film.mp4', 1000)
  put('out/j1.plan/chunk-000.mkv', 2000)
  put('out/j1/000000.png', 3000)
  put('out/review/contact-sheet.png', 400)
  put('out/stills/0.png', 500)
  put('out/studio/export.mp4', 600)
  put('out/deliveries/yt/main.mp4', 700)
  put('node_modules/x/index.js', 800)

  const before = readdirSync(objects).length
  const items = diskItems(root)
  const at = (id: string) => items.find((i) => i.id === id)
  for (const i of items) assert.equal(i.needed, false)
  assert.equal(at('disk:out:renders')?.bytes, 1000)
  assert.equal(at('disk:out:plans')?.bytes, 2000)
  assert.equal(at('disk:out:png-jobs')?.bytes, 3000)
  assert.equal(at('disk:out:review')?.bytes, 400)
  assert.equal(at('disk:out:stills')?.bytes, 500)
  assert.equal(at('disk:out:studio')?.bytes, 600)
  assert.equal(at('disk:out:other')?.bytes, 700)
  assert.equal(at('disk:node_modules')?.bytes, 800)
  assert.ok((at('disk:cache')?.bytes ?? 0) >= 4000)
  assert.ok((at('disk:working-tree')?.bytes ?? 0) >= 5 * 2 ** 20)
  assert.ok((at('disk:versions')?.bytes ?? 0) >= 5 * 2 ** 20)
  assert.ok((at('disk:frozen')?.bytes ?? 0) >= 3 * 2 ** 20)
  assert.match(at('disk')?.detail ?? '', /^\d+\.\d MiB in all$/)
  assert.match(at('disk:working-tree')?.detail ?? '', /^5\.\d MiB \(/)
  assert.match(
    at('disk:prune')?.detail ?? '',
    /^prune --dry-run would free [\d.]+ (B|KiB): 1 revision\(s\), 1 object\(s\), 0 frozen copy\(ies\)$/,
  )
  const kept = items.filter((i) => i.id === 'disk:kept')
  assert.equal(kept.length, 3)
  assert.match(kept[0]?.detail ?? '', /^assets\/clip\.bin 3\.0 MiB: /)
  for (const why of ['label "start"', 'job j1', 'a frozen copy used just now', 'the head'])
    assert.ok(kept[0]?.detail.includes(why), why)
  assert.match(kept[1]?.detail ?? '', /^assets\/music\.bin 2\.0 MiB: /)
  // Sizes only: nothing was removed.
  assert.equal(readdirSync(objects).length, before)
})
