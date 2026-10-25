import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
    const diff = await call('compare', { a: 0, b: 1, path: 'camera' })
    assert.deepEqual(diff.changes, [{ path: 'x', a: 0, b: 10 }])
    assert.ok(diff.pixels.differing > 0)

    const pick = await call('pick', { t: 0, x: 22, y: 12 })
    assert.equal(pick.pick.id, 'box')
    assert.match(pick.source, /^src\/composition\.ts:\d+:\d+$/)

    const camera = await call('get_camera', { t: 1 })
    assert.deepEqual(camera.description.eye, [10, 0, 5])
    assert.equal(Math.round(camera.description.fovY), 90)
    assert.match(camera.source, /composition\.ts/)

    const source = await call('get_source', { id: 'box' })
    assert.equal(source.path, 'box')
    assert.match(source.around, /id: 'box'/)

    const check = await call('check', { times: 4 })
    assert.equal(check.failures.length, 0)
    await assert.rejects(call('get_source', { id: 'nope' }), /No object with id nope/)
    await assert.rejects(call('render', { out: '../escaped.mp4' }), /outside the project/)
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
    const ts = Array.from({ length: 181 }, (_, i) => i / 30)
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
    assert.ok(existsSync(report.contactSheet))
    assert.equal(r.content.length, 1 + 1 + report.frames.length)
    assert.ok(r.content.slice(1).every((c) => c.mimeType === 'image/png'))
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

test('render_frame downscales a big frame to 1024 px on its long side unless full', async () => {
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
  } finally {
    await close()
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

    // 16:9 is main's size, fps, duration and params: all runs it once, and says so.
    const check = await call('check', { times: 2, variants: 'all' })
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
