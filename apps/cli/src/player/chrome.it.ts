// The web player in Chrome, as a site uses it: built from a film with footage, a bake and the
// cache, served as static files on one origin, framed by a page on another: with
// sandbox="allow-scripts" (an opaque origin), and with "allow-scripts allow-same-origin" on a site
// of its own (decision 0024), which takes the bridge's port and drives the runner. Checks the bridge's origin rule,
// that the runner's services are answered in the player's worker (the host hook), and the pixels.
import assert from 'node:assert/strict'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { after, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { VideoColour } from '@shaderera/core'
import { yuv420pToRgba } from '@shaderera/core/gpu'
import { shareFiles } from '../cli/share.ts'
import { chromePath, session } from '../node/browser.ts'
import { buildPlayer } from './build.ts'
import { ffmpeg, footageProject } from './fixtures/make.ts'

const chrome = chromePath()

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.mp4': 'video/mp4',
}

const listen = async (handle: (req: IncomingMessage, res: ServerResponse) => void) => {
  const server = createServer(handle)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  after(() => server.close())
  return (server.address() as AddressInfo).port
}

/**
 * The page a site would be: frames the player, takes its port, opens the film, and reads inspect,
 * the composited pixels and a layer drawn on its own canvas, at t = 0.5 and then 0.1 (a jump back).
 */
const HOST_PAGE = `<!doctype html><meta charset="utf-8"><body><script type="module">
import * as Comlink from '/comlink.mjs'
const q = new URLSearchParams(location.search)
const frame = document.createElement('iframe')
frame.setAttribute('sandbox', q.get('sandbox') ?? 'allow-scripts')
frame.src = q.get('src')
document.body.append(frame)
const messages = []
const done = (r) => { window.result = { messages, ...r } }
const timer = setTimeout(() => done({ port: false }), Number(q.get('wait')))
const b64 = (u8) => {
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000))
  return btoa(s)
}
addEventListener('message', async (e) => {
  if (e.source !== frame.contentWindow) return
  messages.push({ shaderera: e.data?.shaderera, origin: e.origin, ports: e.ports.length })
  if (e.data?.shaderera === 'error') { clearTimeout(timer); return done({ error: e.data.message }) }
  if (e.data?.shaderera !== 'runner') return
  clearTimeout(timer)
  try {
    const api = Comlink.wrap(e.ports[0])
    const opened = await api.open()
    const { width, height } = opened.manifest
    const at = async (t) => {
      const pixels = await api.pixels(t)
      const { layers } = await api.render(t)
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      ctx.drawImage(layers[0].bitmap, 0, 0)
      return {
        inspect: await api.inspect(t),
        layers: layers.map((l) => l.name),
        pixels: b64(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength)),
        drawn: b64(new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer)),
      }
    }
    done({ port: true, manifest: opened.manifest, capabilities: opened.capabilities, half: await at(0.5), back: await at(0.1) })
  } catch (err) {
    done({ port: true, error: String(err?.message ?? err) })
  }
})
</script>`

/** Frame n of the clip as io.video in the CLI decodes it (node/services.ts): full-range RGBA. */
const ffmpegFrame = (file: string, n: number) =>
  spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      file,
      '-vf',
      `select=eq(n\\,${n}),scale=in_color_matrix=auto:in_range=auto:out_range=full,format=rgba`,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-',
    ],
    { maxBuffer: 1 << 24 },
  ).stdout as Buffer

/** Frame n of the clip as io.video's yuv420p in the CLI gives it: the file's planes. */
const ffmpegPlanes = (file: string, n: number) =>
  new Uint8Array(
    spawnSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        file,
        '-vf',
        `select=eq(n\\,${n})`,
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-',
      ],
      { maxBuffer: 1 << 24 },
    ).stdout as Buffer,
  )

/** PSNR over R, G and B. */
const psnr = (a: Uint8Array, b: Uint8Array) => {
  let sum = 0
  let n = 0
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue
    sum += ((a[i] as number) - (b[i] as number)) ** 2
    n++
  }
  return sum === 0 ? Infinity : 10 * Math.log10((255 * 255) / (sum / n))
}

test('the web player plays in a sandboxed frame on an allowed origin only, with its services in its worker', {
  skip: (!ffmpeg && 'needs ffmpeg') || (!chrome && 'needs Chrome'),
  timeout: 300_000,
}, async () => {
  const project = await footageProject()
  const outDir = join(project.root, '.shaderera', 'player')

  // The site, an allowed parent (parents.test.ts: the port goes to an allowed origin only).
  const comlink = fileURLToPath(
    new URL('../../node_modules/comlink/dist/esm/comlink.mjs', import.meta.url),
  )
  const hostPort = await listen((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/comlink.mjs') {
      res.writeHead(200, { 'Content-Type': TYPES['.mjs'] as string })
      return res.end(readFileSync(comlink))
    }
    res.writeHead(200, { 'Content-Type': TYPES['.html'] as string })
    res.end(HOST_PAGE)
  })
  const allowed = `http://127.0.0.1:${hostPort}`

  // The player's server, as docs/player.md asks: every file with ACAO *, the page with its CSP.
  const requests: { method: string; path: string }[] = []
  const playerPort = await listen((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname.slice(1))
    requests.push({ method: req.method ?? '', path })
    const file = normalize(join(outDir, path))
    if (!file.startsWith(outDir) || !existsSync(file) || path === '') {
      res.writeHead(404, { 'Access-Control-Allow-Origin': '*' })
      return res.end()
    }
    const self = `http://${req.headers.host}`
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      ...(path === 'runner.html'
        ? {
            'Content-Security-Policy': [
              "default-src 'self'",
              `script-src 'self' ${self} 'wasm-unsafe-eval'`,
              `worker-src 'self' ${self} data:`,
              `connect-src 'self' ${self}`,
              `img-src 'self' ${self} data: blob:`,
              `font-src 'self' ${self} data: blob:`,
              "style-src 'self' 'unsafe-inline'",
              "form-action 'none'",
              "base-uri 'none'",
              `frame-ancestors ${allowed}`,
              'sandbox allow-scripts allow-same-origin',
            ].join('; '),
          }
        : {}),
    })
    res.end(readFileSync(file))
  })
  const player = await buildPlayer(project, {
    outDir,
    files: Object.keys(shareFiles(project.root).files),
    parents: ['https://shaderera.com', allowed],
  })

  const profile = mkdtempSync(join(tmpdir(), 'shaderera-player-chrome-'))
  const browser: ChildProcess = spawn(
    chrome as string,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--enable-unsafe-webgpu',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  const exited = new Promise<string>((done) => browser.once('exit', (c) => done(String(c))))
  try {
    let devtools = ''
    for (let i = 0; i < 200 && !/^\d+$/.test(devtools); i++) {
      try {
        devtools = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0] ?? ''
      } catch {}
      if (!/^\d+$/.test(devtools)) await sleep(100)
    }
    const targets = (await (await fetch(`http://127.0.0.1:${devtools}/json`)).json()) as {
      type: string
      webSocketDebuggerUrl: string
    }[]
    const page = targets.find((t) => t.type === 'page')
    assert.ok(page, 'Chrome opened a page')
    const cdp = await session(page.webSocketDebuggerUrl, exited, {
      ms: 120_000,
      expired: () => browser.kill(),
    })
    await cdp.send('Runtime.enable')
    type Result = {
      port: boolean
      error?: string
      messages: { shaderera: string; origin: string; ports: number }[]
      manifest: { width: number; height: number }
      capabilities: { deep: boolean; yuv: boolean }
      half: At
      back: At
    }
    type At = { inspect: Inspect; layers: string[]; pixels: string; drawn: string }
    type Inspect = {
      clip: { width: number; height: number; fps: number; frames: number }
      frame: number
      colour: { matrix: string; range: string; chroma: string }
      planes: string
      level: { frames: number; first: number; last: number }
      cache: { bytes: number[]; made: number }
    }
    const run = async (
      origin: string,
      wait: number,
      at = `http://127.0.0.1:${playerPort}`,
      sandbox = 'allow-scripts',
    ): Promise<Result> => {
      const src = `${at}/runner.html?parent=${encodeURIComponent(origin)}`
      await cdp.send('Page.navigate', {
        url: `${origin}/host.html?src=${encodeURIComponent(src)}&wait=${wait}&sandbox=${encodeURIComponent(sandbox)}`,
      })
      for (;;) {
        await sleep(200)
        const r = await cdp.send<{ result: { value?: Result } }>('Runtime.evaluate', {
          expression: 'window.result ?? null',
          returnByValue: true,
        })
        if (r.result.value) return r.result.value
      }
    }

    const r = await run(allowed, 120_000)
    assert.equal(r.error, undefined)
    // The port arrives from the frame, whose origin is opaque: a site checks e.source.
    assert.deepEqual(r.messages, [{ shaderera: 'runner', origin: 'null', ports: 1 }])
    assert.equal(r.capabilities.deep, true, 'WebGPU in the player worker')
    assert.deepEqual([r.manifest.width, r.manifest.height], [320, 180])
    // The host hook: io.video, io.bake and io.cache answered in the player's worker.
    const { planes: _, ...half } = r.half.inspect
    assert.deepEqual(half, {
      clip: { width: 320, height: 180, fps: 30, frames: 30 },
      frame: 15,
      // The proxy's planes (media.ts).
      colour: { matrix: 'bt709', range: 'limited', chroma: 'left' },
      level: { frames: 3, first: 100, last: 102 },
      cache: { bytes: [7, 8, 9, 7, 8, 9], made: 1 },
    })
    assert.equal(r.back.inspect.frame, 3)
    assert.deepEqual(r.half.layers, ['clip'])
    // Only GETs of the player's own files: nothing asked a CLI process or a runner server.
    for (const q of requests) {
      assert.equal(q.method, 'GET')
      assert.ok(player.files.includes(q.path), `${q.path} is a player file`)
    }

    // On a site of its own with "allow-same-origin" (decision 0024): the same film, and the port
    // from the player's real origin, which a site checks besides e.source.
    const own = `http://localhost:${playerPort}`
    const o = await run(allowed, 120_000, own, 'allow-scripts allow-same-origin')
    assert.equal(o.error, undefined)
    assert.deepEqual(o.messages, [{ shaderera: 'runner', origin: own, ports: 1 }])
    assert.equal(o.capabilities.deep, true, 'WebGPU in the player worker')
    assert.deepEqual(o.half.inspect.clip, r.half.inspect.clip)
    assert.equal(o.half.inspect.frame, 15)
    assert.equal(o.back.inspect.frame, 3)

    // The pixels: the clip's frame, as ffmpeg decodes it, and not its neighbours.
    const clip = join(project.root, 'assets', 'clip.mp4')
    for (const [at, frame] of [
      [r.half, 15],
      [r.back, 3],
    ] as const) {
      const pixels = new Uint8Array(Buffer.from(at.pixels, 'base64'))
      const drawn = new Uint8Array(Buffer.from(at.drawn, 'base64'))
      assert.equal(pixels.length, 320 * 180 * 4)
      assert.ok(psnr(pixels, drawn) > 40, 'the drawn layer is the composited frame')
      const same = psnr(pixels, ffmpegFrame(clip, frame))
      const before = psnr(pixels, ffmpegFrame(clip, frame - 1))
      const next = psnr(pixels, ffmpegFrame(clip, frame + 1))
      console.log(
        `frame ${frame}: ${same.toFixed(1)} dB; ${frame - 1}: ${before.toFixed(1)} dB; ${frame + 1}: ${next.toFixed(1)} dB`,
      )
      assert.ok(same > 28, `frame ${frame} at ${same} dB`)
      assert.ok(same > before + 3 && same > next + 3, 'not a neighbouring frame')
      // yuv420p: the proxy's own planes, close to the CLI's planes of the original (BT.601 untagged
      // there, BT.709 in the proxy: compared as RGB).
      const planes = new Uint8Array(Buffer.from(at.inspect.planes, 'base64'))
      assert.equal(planes.length, 320 * 180 * 1.5)
      const original = ffmpegPlanes(clip, frame)
      const db = psnr(
        yuv420pToRgba(planes, 320, 180, at.inspect.colour as VideoColour),
        yuv420pToRgba(original, 320, 180, { matrix: 'bt601', range: 'limited', chroma: 'left' }),
      )
      console.log(`yuv420p frame ${frame}: ${db.toFixed(1)} dB`)
      assert.ok(db > 32, `yuv420p frame ${frame} at ${db} dB`)
    }
    cdp.close()
  } finally {
    browser.kill()
    await exited
    // Windows: Chrome's helper processes hold files a moment after it exits (EPERM). A profile
    // left in the temp folder is only disk; it must not fail the test (as browser.ts's release).
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    } catch (error) {
      process.stderr.write(`Could not remove ${profile} (${String(error)}); delete it later.\n`)
    }
  }
})
