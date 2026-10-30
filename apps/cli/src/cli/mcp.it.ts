import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { decode } from 'fast-png'
import { tempDir } from '../fixtures/temp.ts'
import { createJob } from '../project/jobs.ts'
import { createServer } from './mcp.ts'

/** A fixture in its own temp folder: test files run in parallel, and each build empties `.shaderera/`. */
const copy = (dir: string) => {
  const root = tempDir('fixture')
  cpSync(fileURLToPath(new URL(dir, import.meta.url)), root, {
    recursive: true,
    filter: (f) => !/[\\/](out|\.shaderera)$/.test(f),
  })
  return root
}
const fixture = copy('./fixtures/mcp/')
const cameraDebug = fileURLToPath(new URL('./fixtures/camera-debug/', import.meta.url))
const stateful = copy('./fixtures/stateful/')
const params = copy('./fixtures/params/')
const bin = fileURLToPath(new URL('../../bin/shaderera.js', import.meta.url))
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const moved = { view: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -5, 1], projection: [] }

/** A client connected in-process to the MCP server on `root`. */
const connect = async (root: string, flags: { variant?: string } = {}) => {
  const server = createServer(root, flags)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
  // biome-ignore lint/suspicious/noExplicitAny: tool results are JSON
  const call = async (name: string, args: { [k: string]: unknown }): Promise<any> => {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text?: string; data?: string }[]
      isError?: boolean
    }
    if (r.isError) throw new Error(r.content[0]?.text)
    return name === 'render_frame' || name === 'still'
      ? r
      : JSON.parse(r.content[0]?.text as string)
  }
  return { call, close: () => client.close() }
}

test('the MCP tools render, inspect, compare, pick and read the camera of a fixture', async () => {
  const { call, close } = await connect(fixture)
  try {
    const frame = await call('render_frame', { t: 0.5 })
    const stats = JSON.parse(frame.content[0].text)
    assert.equal(frame.content.length, 1)
    assert.deepEqual(stats.alphaBox, { x: 15, y: 10, width: 8, height: 8 })
    assert.deepEqual(stats.layers, [{ name: 'box' }])
    const through = await call('render_frame', { t: 0.5, image: true, camera: moved })
    assert.equal(JSON.parse(through.content[0].text).alphaBox.x, 20)
    assert.deepEqual(JSON.parse(through.content[1].text), { width: 64, height: 36 })
    assert.equal(through.content[2].mimeType, 'image/png')
    assert.equal(
      JSON.parse((await call('render_frame', { t: 0.5 })).content[0].text).alphaBox.x,
      15,
    )

    assert.deepEqual(await call('inspect', { t: 0.5, path: 'box.x' }), 15)
    const diff = await call('compare', { a: 0, b: 0.5, path: 'camera' })
    assert.deepEqual(diff.changes, [{ path: 'x', a: 0, b: 5 }])
    assert.ok(diff.pixels.differing > 0)

    const pick = await call('pick', { t: 0, x: 22, y: 12 })
    assert.equal(pick.pick.id, 'box')
    assert.match(pick.source, /^src\/composition\.ts:\d+:\d+$/)

    const camera = await call('get_camera', { t: 0.5 })
    assert.deepEqual(camera.description.eye, [5, 0, 5])
    assert.equal(Math.round(camera.description.fovY), 90)
    assert.match(camera.source, /composition\.ts/)

    const source = await call('get_source', { id: 'box' })
    assert.equal(source.path, 'box')
    assert.match(source.around, /id: 'box'/)

    const check = await call('check', { samples: 4 })
    assert.equal(check.failures.length, 0)
    await assert.rejects(call('get_source', { id: 'nope' }), /No object with id nope/)
    await assert.rejects(call('render', { out: '../escaped.mp4' }), /outside the project/)
  } finally {
    await close()
  }
})

test('every time a tool takes is checked first, naming the input', async () => {
  const { call, close } = await connect(fixture)
  try {
    await assert.rejects(call('render_frame', {}), /render_frame needs t \(seconds\)/)
    await assert.rejects(call('render_frame', { t: 'abc' }), /Not a time in seconds: t "abc"/)
    await assert.rejects(call('render_frame', { t: -5 }), /Outside the film \(0 to 1 s\): -5\./)
    await assert.rejects(call('render_frame', { t: 1e6 }), /Outside the film \(0 to 1 s\): 1000000/)
    await assert.rejects(call('inspect', { t: 2 }), /Outside the film \(0 to 1 s\): 2\./)
    await assert.rejects(call('compare', { a: 0, b: 2 }), /Outside the film \(0 to 1 s\): 2\./)
    await assert.rejects(call('compare', { a: 0 }), /compare needs b/)
    await assert.rejects(call('pick', { t: 2, x: 0, y: 0 }), /Outside the film/)
    await assert.rejects(call('get_camera', { t: 2 }), /Outside the film/)
    await assert.rejects(call('get_source', { id: 'box', t: 2 }), /Outside the film/)
    await assert.rejects(call('still', { times: ['a'] }), /Not a time in seconds: "a"/)
    await assert.rejects(call('still', { times: [0, 2] }), /Outside the film \(0 to 1 s\): 2\./)
    await assert.rejects(call('render', { from: 'a' }), /Not a time in seconds: from "a"/)
    await assert.rejects(call('render', { from: 0.8, to: 0.2 }), /The window 0\.8–0\.2 s/)
  } finally {
    await close()
  }
})

test('a bad render range leaves the encoder of the next render as it was', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const root = copy('./fixtures/mcp/')
  const { call, close } = await connect(root)
  try {
    const before = await call('render', { out: 'out/before.mp4' })
    await assert.rejects(call('render', { from: 0.8, to: 0.2 }), /The window/)
    const after = await call('render', { out: 'out/after.mp4' })
    assert.equal(after.encoder, before.encoder)
  } finally {
    await close()
  }
})

test('render refuses a host on a software adapter unless softwareGpu: true', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const root = copy('./fixtures/mcp/')
  // A webgpu whose adapter is Chrome's SwiftShader, as it answers (node/adapter.test.ts), and
  // gives no device: the Node host then composites on the CPU, as without webgpu.
  const webgpu = join(root, 'node_modules', 'webgpu')
  mkdirSync(webgpu, { recursive: true })
  writeFileSync(join(webgpu, 'package.json'), JSON.stringify({ name: 'webgpu', version: '0.0.0' }))
  writeFileSync(
    join(webgpu, 'index.js'),
    `exports.globals = {}
exports.create = () => ({
  requestAdapter: async () => ({
    info: { vendor: 'google', architecture: 'swiftshader', device: '', description: '', isFallbackAdapter: true },
    features: new Set(),
    limits: {},
    requestDevice: async () => undefined,
  }),
})
`,
  )
  const { call, close } = await connect(root)
  try {
    await assert.rejects(
      call('render', { out: 'out/soft.mp4' }),
      /node host's WebGPU adapter is software, SwiftShader \(google swiftshader\).*Pass softwareGpu: true/,
    )
    assert.equal(existsSync(join(root, 'versions')), false)
    const r = await call('render', { out: 'out/soft.mp4', softwareGpu: true })
    assert.equal(r.frames, 10)
  } finally {
    await close()
  }
})

test("one call's camera override never reaches a call made at the same time", async () => {
  const { call, close } = await connect(fixture)
  try {
    const [through, own] = await Promise.all([
      call('render_frame', { t: 0.5, camera: moved }),
      call('render_frame', { t: 0.5 }),
    ])
    assert.equal(JSON.parse(through.content[0].text).alphaBox.x, 20)
    assert.equal(JSON.parse(own.content[0].text).alphaBox.x, 15)
  } finally {
    await close()
  }
})

test('over real stdio, a source that logs keeps the stream clean, and render refuses it', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, 'mcp', '--root', stateful],
    stderr: 'pipe',
  })
  const errors: unknown[] = []
  transport.onerror = (e) => errors.push(e)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(transport)
  try {
    const frame = (await client.callTool({ name: 'render_frame', arguments: { t: 0 } })) as {
      content: { text: string }[]
    }
    assert.equal(JSON.parse(frame.content[0]?.text as string).meanRgba[3], 255)
    const out = 'out/refused-mcp.mp4'
    const r = (await client.callTool({ name: 'render', arguments: { out } })) as {
      content: { text: string }[]
      isError?: boolean
    }
    assert.equal(r.isError, true)
    assert.match(r.content[0]?.text as string, /not deterministic/)
    assert.equal(existsSync(join(stateful, out)), false)
    assert.deepEqual(errors, [])
  } finally {
    await client.close()
  }
})

test('the server starts outside a project; a call finds its project from root, or says how to start one', async () => {
  const empty = tempDir('mcp-empty')
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, 'mcp'],
    cwd: empty,
    stderr: 'pipe',
  })
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(transport)
  try {
    const { tools } = await client.listTools()
    assert.ok(tools.every((t) => 'root' in (t.inputSchema.properties ?? {})))
    const none = (await client.callTool({ name: 'inspect', arguments: { t: 0 } })) as {
      content: { text: string }[]
      isError?: boolean
    }
    assert.equal(none.isError, true)
    assert.match(none.content[0]?.text as string, /No Shaderera project .* create-shaderera/)
    const frame = (await client.callTool({
      name: 'render_frame',
      arguments: { t: 0.5, root: fixture },
    })) as { content: { text: string }[] }
    assert.equal(JSON.parse(frame.content[0]?.text as string).alphaBox.x, 15)
  } finally {
    await client.close()
  }
})

test('MCP tools alone find the planted camera jump in fixtures/camera-debug', async () => {
  const { call, close } = await connect(cameraDebug)
  try {
    const ts = Array.from({ length: 180 }, (_, i) => i / 30)
    const eyes: number[][] = []
    for (const t of ts) eyes.push((await call('get_camera', { t })).description.eye)
    const steps = eyes
      .slice(1)
      .map((e, i) => Math.hypot(...e.map((v, j) => v - (eyes[i]?.[j] ?? 0))))
    const at = steps.indexOf(Math.max(...steps))
    const [a, b] = [ts[at] as number, ts[at + 1] as number]
    const diff = await call('compare', { a, b, path: 'camera' })
    const between = await call('inspect', { t: b, path: 'camera.between' })
    const source = await call('get_source', { id: between[0] })
    console.log(
      JSON.stringify({
        before: steps.slice(at - 3, at).map((s) => s.toFixed(4)),
        jump: { a, b, step: steps[at]?.toFixed(4) },
        after: steps.slice(at + 1, at + 4).map((s) => s.toFixed(4)),
        changes: diff.changes,
        pixels: diff.pixels,
        between,
        source: `${source.file}:${source.line}:${source.column}`,
      }),
    )
    assert.ok(a < 4.12 && b >= 4.12)
    assert.ok((steps[at] as number) > 5 * (steps[at - 1] as number))
  } finally {
    await close()
  }
})

test('the review tool returns the report, the contact sheet and the frames as images', async () => {
  const root = tempDir('mcp-review')
  cpSync(fixture, root, { recursive: true, filter: (f) => !/[\\/](out|\.shaderera)$/.test(f) })
  const server = createServer(root)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
  try {
    // Windows reports the copy's own changes late; let them drop the first child before review.
    await client.callTool({ name: 'render_frame', arguments: { t: 0 } })
    await sleep(500)
    const r = (await client.callTool({ name: 'review', arguments: { quick: true } })) as {
      content: { type: string; text?: string; mimeType?: string }[]
    }
    const report = JSON.parse(r.content[0]?.text as string)
    assert.equal(report.version, 1)
    // Paths relative to the project, so the result doesn't repeat its folder.
    assert.equal(report.contactSheet, 'out/review/contact-sheet.png')
    assert.ok(existsSync(join(root, report.contactSheet)))
    assert.ok(
      report.frames.every(
        (f: { file: string; thumb: string }) =>
          f.file.startsWith('out/review/') && existsSync(join(root, f.thumb)),
      ),
    )
    assert.equal(r.content.length, 1 + 1 + report.frames.length)
    assert.ok(r.content.slice(1).every((c) => c.mimeType === 'image/png'))
    // save gives the count of the revision's files, not each one's hash.
    const s = (await client.callTool({ name: 'save', arguments: { label: 'one' } })) as {
      content: { text: string }[]
    }
    const saved = JSON.parse(s.content[0]?.text as string)
    assert.equal(saved.label, 'one')
    assert.equal(typeof saved.files, 'number')
    assert.ok(saved.files > 0)
  } finally {
    await client.close()
  }
})

test('variant and params reach render_frame, inspect, compare and still; --variant is the default', async () => {
  const { call, close } = await connect(params)
  try {
    assert.equal(await call('inspect', { t: 0, path: 'grey' }), 0)
    assert.equal(await call('inspect', { t: 0, path: 'grey', variant: 'lighter' }), 100)
    assert.equal(await call('inspect', { t: 0, path: 'grey', params: { grey: 42 } }), 42)
    const both = { t: 0, path: 'grey', variant: 'lighter', params: { grey: 7 } }
    assert.equal(await call('inspect', both), 7)
    const frame = await call('render_frame', { t: 0, params: { grey: 42 } })
    assert.equal(JSON.parse(frame.content[0].text).meanRgba[0], 42)
    const diff = await call('compare', { a: 0, b: 0.5, variant: 'lighter' })
    assert.deepEqual(diff.changes, [{ path: 't', a: 0, b: 0.5 }])
    await assert.rejects(call('inspect', { t: 0, params: { nope: 1 } }), /Unknown params: nope/)
    await assert.rejects(call('inspect', { t: 0, variant: 'nope' }), /no variant "nope"/)
    await assert.rejects(call('inspect', { t: 0, params: [1] }), /params is an object/)
    await assert.rejects(call('export', {}), /Unknown tool export/)

    const sheet = await call('still', { times: [0, 0.5], variant: 'lighter' })
    assert.deepEqual(JSON.parse(sheet.content[0].text), { times: [0, 0.5] })
    assert.equal(sheet.content[1].mimeType, 'image/png')
    assert.deepEqual(
      JSON.parse((await call('still', { every: 0.25 })).content[0].text).times,
      [0, 0.25, 0.5, 0.75],
    )
    await assert.rejects(call('still', { every: 0.01 }), /at most 64/)
    await assert.rejects(call('still', {}), /times or every/)
  } finally {
    await close()
  }
  const lighter = await connect(params, { variant: 'lighter' })
  try {
    assert.equal(await lighter.call('inspect', { t: 0, path: 'grey' }), 100)
    assert.equal((await lighter.call('job', {})).variant, 'lighter')
  } finally {
    await lighter.close()
  }
})

test('render_frame downscales a big frame to 1024 px on its long side unless full, and never returns one over 2048', async () => {
  const root = tempDir('mcp-big')
  mkdirSync(join(root, 'src'))
  writeFileSync(
    join(root, 'shaderera.json'),
    JSON.stringify({
      entry: './src/composition.ts',
      fps: 10,
      duration: 1,
      width: 2000,
      height: 1000,
    }),
  )
  writeFileSync(
    join(root, 'src', 'composition.ts'),
    `export default ({ io }) => {
  const canvas = io.canvas(2000, 1000)
  return {
    render: async () => {
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = 'rgb(0, 128, 255)'
      ctx.fillRect(0, 0, 2000, 1000)
      return { color: canvas }
    },
  }
}
`,
  )
  const { call, close } = await connect(root)
  try {
    const small = await call('render_frame', { t: 0, image: true })
    assert.deepEqual(JSON.parse(small.content[1].text), { width: 1024, height: 512 })
    const full = await call('render_frame', { t: 0, image: true, full: true })
    assert.deepEqual(JSON.parse(full.content[1].text), { width: 2000, height: 1000 })
    assert.ok(small.content[2].data.length < full.content[2].data.length)

    // No image over 2048 px: the scale is clamped and the size block says so.
    const close16 = await call('render_frame', {
      t: 0,
      image: true,
      region: [0, 0, 600, 300],
      scale: 16,
    })
    assert.deepEqual(JSON.parse(close16.content[1].text), {
      width: 1800,
      height: 900,
      region: { x: 0, y: 0, width: 600, height: 300 },
      scale: 3,
      note: 'scale 16 → 3 (long side ≤ 2048)',
    })
    const png16 = decode(Buffer.from(close16.content[2].data, 'base64'))
    assert.deepEqual([png16.width, png16.height], [1800, 900])
    const whole = await call('render_frame', {
      t: 0,
      image: true,
      region: [0, 0, 2000, 1000],
      scale: 3,
    })
    const size = JSON.parse(whole.content[1].text)
    assert.deepEqual([size.width, size.height, size.scale], [2000, 1000, 1])
    assert.equal(size.note, 'scale 3 → 1 (long side ≤ 2048)')
  } finally {
    await close()
  }
})

test('render takes draft, variant and params, and reports its frames as progress', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const root = tempDir('mcp-draft')
  mkdirSync(join(root, 'src'))
  writeFileSync(
    join(root, 'shaderera.json'),
    JSON.stringify({
      entry: './src/composition.ts',
      fps: 10,
      duration: 1,
      width: 1280,
      height: 720,
      params: { type: 'object', properties: { grey: { type: 'number', default: 0 } } },
      variants: { short: { label: 'half', duration: 0.5 } },
    }),
  )
  writeFileSync(
    join(root, 'src', 'composition.ts'),
    `export default ({ io, manifest, params }) => {
  const { width, height } = manifest
  const canvas = io.canvas(width, height)
  return {
    render: async () => {
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = \`rgb(\${params.grey}, 0, 0)\`
      ctx.fillRect(0, 0, width, height)
      return { color: canvas }
    },
  }
}
`,
  )
  const server = createServer(root)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
  try {
    const steps: { progress: number; total?: number }[] = []
    const r = (await client.callTool(
      { name: 'render', arguments: { draft: 360, variant: 'short', params: { grey: 200 } } },
      undefined,
      { onprogress: (p) => steps.push(p) },
    )) as { content: { text: string }[]; isError?: boolean }
    assert.equal(r.isError, undefined, r.content[0]?.text)
    const done = JSON.parse(r.content[0]?.text as string)
    // Beside the main film, never over it, at 640×360: the variant's 0.5 s at 10 fps.
    assert.match(done.out, /-short-draft\.mp4$/)
    assert.deepEqual([done.probe.video.width, done.probe.video.height], [640, 360])
    assert.equal(done.frames, 5)
    assert.deepEqual(steps.at(-1), { progress: 5, total: 5 })
    const job = (await client.callTool({
      name: 'render',
      arguments: { job: 'nope', draft: true },
    })) as { content: { text: string }[]; isError?: boolean }
    assert.equal(job.isError, true)
  } finally {
    await client.close()
  }
})

test("render of a job renders the job's frozen delivery, not a default mp4", {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const root = copy('./fixtures/mcp/')
  await createJob(root, { by: 'agent', name: 'master', delivery: { format: 'prores-hq' } })
  const { call, close } = await connect(root)
  try {
    const r = await call('render', { job: 'master' })
    assert.match(r.out, /master\.mov$/)
    assert.equal(r.probe.video.codec, 'prores')
  } finally {
    await close()
  }
})

test('MCP still, check and review take variants: one host each, one sheet side by side', async () => {
  const ratios = copy('./fixtures/ratios/')
  const { call, close } = await connect(ratios)
  try {
    const still = await call('still', { times: [0.5, 1.5], variants: ['16:9', '9:16'] })
    assert.deepEqual(JSON.parse(still.content[0].text), {
      times: [0.5, 1.5],
      variants: [
        { variant: '16:9', width: 1920, height: 1080 },
        { variant: '9:16', width: 1080, height: 1920 },
      ],
    })
    const sheet = decode(Buffer.from(still.content[1].data, 'base64'))
    assert.deepEqual([sheet.width, sheet.height], [8 + 1280 + 8 + 405 + 8, 8 + 2 * (720 + 44 + 8)])
    // 16 portrait frames make a sheet ~2900 px tall: it comes scaled to 2048.
    const tall = await call('still', { every: 0.125, variant: '9:16' })
    const tallSheet = decode(Buffer.from(tall.content[1].data, 'base64'))
    assert.equal(Math.max(tallSheet.width, tallSheet.height), 2048)

    // 16:9 is main's size, fps, duration and params: all runs it once, and says so.
    const check = await call('check', { samples: 2, variants: 'all' })
    assert.equal(check.main, '16:9')
    assert.deepEqual(
      check.variants.map((v: { variant: string; failures: unknown[] }) => [
        v.variant,
        v.failures.length,
      ]),
      [
        ['16:9', 0],
        ['9:16', 0],
      ],
    )
    const review = await call('review', { quick: true, variants: ['9:16', '16:9'] })
    assert.deepEqual(
      review.variants.map((r: { variant: string; manifest: { width: number } }) => [
        r.variant,
        r.manifest.width,
      ]),
      [
        ['9:16', 1080],
        ['16:9', 1920],
      ],
    )
    assert.ok(existsSync(join(ratios, 'out', 'review', '9_16', 'contact-sheet.png')))
    assert.equal(review.variants[0].contactSheet, 'out/review/9_16/contact-sheet.png')
    await assert.rejects(call('still', { times: [0], variants: ['4:5'] }), /no variant "4:5"/)
    await assert.rejects(
      call('check', { variant: '16:9', variants: ['9:16'] }),
      /variant or variants, not both/,
    )
  } finally {
    await close()
  }
})

test('restore, undo and diff go back and compare revisions; the next call sees the files', async () => {
  const root = copy('./fixtures/mcp/')
  const { call, close } = await connect(root)
  try {
    const file = join(root, 'src', 'composition.ts')
    const before = readFileSync(file, 'utf8')
    const first = await call('save', { label: 'first' })
    writeFileSync(file, `${before}\n// edited\n`)
    const second = await call('save', { label: 'second' })

    const diff = await call('diff', { a: first.id, b: second.id })
    assert.deepEqual(diff.changed, ['src/composition.ts'])
    assert.match(diff.patch, /\+\/\/ edited/)
    assert.equal((await call('diff', { a: first.id, stat: true })).patch, undefined)

    const back = await call('undo', {})
    assert.equal(back.id, first.id)
    assert.equal(back.files, undefined)
    assert.equal(readFileSync(file, 'utf8'), before)
    await call('render_frame', { t: 0 })

    assert.equal((await call('restore', { id: second.id })).id, second.id)
    assert.match(readFileSync(file, 'utf8'), /\/\/ edited/)
    const log = (await call('versions', {})).log
    assert.deepEqual(
      log.slice(-2).map((e: { action: string; by: string }) => [e.action, e.by]),
      [
        ['undo', 'agent'],
        ['restore', 'agent'],
      ],
    )
  } finally {
    await close()
  }
})

test('render_frame and still take a revision: they render it, not the tree as it is now', async () => {
  const root = copy('./fixtures/mcp/')
  const { call, close } = await connect(root)
  const sha = async (args: { [k: string]: unknown }) =>
    JSON.parse((await call('render_frame', args)).content[0].text).sha256
  try {
    const file = join(root, 'src', 'composition.ts')
    const r = (await call('save', { label: 'what they saw' })).id
    const was = await sha({ t: 0.5 })
    writeFileSync(file, readFileSync(file, 'utf8').replace('rgb(255, 0, 0)', 'rgb(0, 0, 255)'))
    const now = await sha({ t: 0.5 })
    assert.notEqual(now, was)
    // R's frame, twice (the second from the same open copy), and the tree's again after.
    assert.equal(await sha({ t: 0.5, revision: r }), was)
    assert.equal(await sha({ t: 0.5, revision: r }), was)
    assert.equal(await sha({ t: 0.5 }), now)
    const sheet = await call('still', { times: [0, 0.5], revision: r })
    assert.equal(sheet.content[1].mimeType, 'image/png')
    // While the server keeps R open, its frozen copy is marked in use by this process.
    assert.deepEqual(readdirSync(join(root, '.shaderera', 'revisions', `${r}.using`)), [
      String(process.pid),
    ])

    // R pruned while its host is kept: the next call says so instead of rendering the open copy.
    const kept = readFileSync(join(root, 'versions', 'revisions', `${r}.json`))
    rmSync(join(root, 'versions', 'revisions', `${r}.json`))
    appendFileSync(join(root, 'versions', 'pruned.jsonl'), `${JSON.stringify({ id: r })}\n`)
    await assert.rejects(
      call('render_frame', { t: 0.5, revision: r }),
      new RegExp(`Revision ${r} was pruned`),
    )
    writeFileSync(join(root, 'versions', 'revisions', `${r}.json`), kept)
    assert.equal(await sha({ t: 0.5, revision: r }), was)
    await assert.rejects(
      call('render_frame', { t: 0.5, revision: 'feedfacefeedface' }),
      /No revision feedfacefeedface/,
    )
    // A revision a prune removed says so.
    const gone = (await call('save', { label: 'gone' })).id
    rmSync(join(root, 'versions', 'revisions', `${gone}.json`))
    appendFileSync(join(root, 'versions', 'pruned.jsonl'), `${JSON.stringify({ id: gone })}\n`)
    await assert.rejects(
      call('still', { times: [0], revision: gone }),
      new RegExp(`Revision ${gone} was pruned`),
    )
  } finally {
    await close()
  }
  // Closing the server released it: the copy stays in the pool, unmarked.
  await sleep(100)
  const copies = join(root, '.shaderera', 'revisions')
  const kept = readdirSync(copies).filter((n) => n.endsWith('.using'))
  for (const m of kept) assert.deepEqual(readdirSync(join(copies, m)), [], m)
})

test('restore puts back a clip the open child is decoding: the child closes first', async () => {
  // While the session's child plays a clip (one too long for the pipe), ffmpeg holds the file open; Windows refuses to
  // replace a file held open, which left a half-restored tree.
  const root = tempDir('mcp-restore-clip')
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'assets'))
  const clip = join(root, 'assets', 'clip.mp4')
  const make = (color: string) =>
    spawnSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=320x240:r=10:d=10`,
      '-pix_fmt',
      'yuv420p',
      clip,
    ])
  make('red')
  writeFileSync(
    join(root, 'shaderera.json'),
    JSON.stringify({ entry: './src/c.ts', fps: 10, duration: 1, width: 320, height: 240 }),
  )
  writeFileSync(
    join(root, 'src', 'c.ts'),
    `export default async ({ io }) => {
  const clip = await io.video('assets/clip.mp4')
  const canvas = io.canvas(320, 240)
  const ctx = canvas.getContext('2d')
  return {
    render: async (t) => {
      const image = ctx.createImageData(320, 240)
      image.data.set(await clip.frame(Math.min(9, Math.floor(t * 10))))
      ctx.putImageData(image, 0, 0)
      return { color: canvas }
    },
  }
}`,
  )
  const { call, close } = await connect(root)
  try {
    const red = await call('save', { label: 'red' })
    make('blue')
    await call('save', { label: 'blue' })
    const blue = JSON.parse((await call('render_frame', { t: 0.5 })).content[0].text).meanRgba
    // The decoder now holds assets/clip.mp4 open.
    assert.equal((await call('restore', { id: red.id })).id, red.id)
    const back = JSON.parse((await call('render_frame', { t: 0.5 })).content[0].text).meanRgba
    assert.ok(back[0] > 200 && blue[2] > 200, `${back} after ${blue}`)
  } finally {
    await close()
  }
})

test('inspect with track returns the curve inspect --track gives', async () => {
  const { call, close } = await connect(fixture)
  try {
    const curve = await call('inspect', { track: 'box.x', from: 0, to: 0.5 })
    const cli = spawnSync(
      process.execPath,
      [bin, 'inspect', '--track', 'box.x', '--from', '0', '--to', '0.5', '--json'],
      { cwd: fixture, encoding: 'utf8' },
    )
    assert.equal(cli.status, 0, cli.stderr)
    assert.deepEqual(curve, JSON.parse(cli.stdout).result)
    assert.equal(curve[0].value, 20)
    assert.ok(curve.length > 2 && curve.every((p: { t: number }) => p.t <= 0.5))
    // track alone: the whole film, no t needed.
    const whole = await call('inspect', { track: 'box.x' })
    assert.ok(whole.length > curve.length)
    await assert.rejects(
      call('inspect', { track: 'box.x', from: 0.5, to: 0.2 }),
      /The window 0.5–0.2 s/,
    )
    await assert.rejects(call('inspect', { track: 'box.x', to: 'x' }), /Not a time in seconds: to/)
    await assert.rejects(call('inspect', { track: 'nope' }), /Nothing at nope/)
    await assert.rejects(call('inspect', {}), /inspect needs t, or track/)
  } finally {
    await close()
  }
})

test('a call whose frame never settles fails within the timeout, naming t, and the next call runs', async () => {
  const root = copy('./fixtures/params/')
  const manifest = JSON.parse(readFileSync(join(root, 'shaderera.json'), 'utf8'))
  manifest.params.properties.hang = { type: 'boolean', default: false }
  writeFileSync(join(root, 'shaderera.json'), JSON.stringify(manifest))
  writeFileSync(
    join(root, 'src', 'composition.ts'),
    `export default ({ io, params }) => {
  const canvas = io.canvas(16, 16)
  return {
    render: async (t) => {
      if (params.hang && t > 0.5) await new Promise(() => {})
      canvas.getContext('2d').fillRect(0, 0, 16, 16)
      return { color: canvas }
    },
  }
}
`,
  )
  const server = createServer(root, { timeout: '5' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
  try {
    const hung = client.callTool({
      name: 'render_frame',
      arguments: { t: 0.6, params: { hang: true } },
    }) as Promise<{ content: { text: string }[]; isError?: boolean }>
    // Queued behind the hung call (MCP's calls run one at a time).
    const next = client.callTool({ name: 'render_frame', arguments: { t: 0.6 } }) as Promise<{
      isError?: boolean
    }>
    const failed = await hung
    assert.equal(failed.isError, true)
    assert.match(failed.content[0]?.text ?? '', /took longer than 5000 ms on render at t = 0\.6 s/)
    assert.notEqual((await next).isError, true)
  } finally {
    await client.close()
  }
})
