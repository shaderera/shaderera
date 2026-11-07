import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../fixtures/temp.ts'

const main = fileURLToPath(new URL('./main.ts', import.meta.url))
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0

/**
 * A film of a clip the size of its frame, drawn three ways (#508): `slow` puts its RGBA frames on a
 * canvas and returns the canvas, `fast` converts its yuv420p planes with videoTexture and returns
 * the texture, `plain` has no footage and returns a canvas. Each frame first spends a while in
 * arithmetic, so the film's own drawing sets a render's pace. And a large still drawn two ways (#773):
 * `still` draws it scaled on the canvas every frame, `stillGpu` writes it once to a texture. The
 * fast and stillGpu variants need the Node host's GPU (`webgpu`, as ports.it.ts): without one they
 * fail, they do not skip.
 */
const film = () => {
  const root = tempDir('footage-draw')
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'assets'))
  mkdirSync(join(root, 'node_modules', '@shaderera'), { recursive: true })
  for (const [from, to] of [
    ['../../fixtures/particles/node_modules/webgpu', 'webgpu'],
    ['../../node_modules/@shaderera/core', '@shaderera/core'],
  ] as const)
    symlinkSync(
      realpathSync(join(import.meta.dirname, from)),
      join(root, 'node_modules', to),
      'junction',
    )
  writeFileSync(
    join(root, 'shaderera.json'),
    JSON.stringify({
      entry: './src/c.ts',
      fps: 10,
      duration: 1,
      width: 64,
      height: 36,
      variants: { slow: {}, fast: {}, plain: {}, still: {}, stillGpu: {} },
    }),
  )
  writeFileSync(join(root, 'package.json'), '{ "type": "module", "private": true }')
  writeFileSync(
    join(root, 'src', 'c.ts'),
    `import { videoTexture } from '@shaderera/core/gpu'
const busy = () => {
  let x = 1
  for (let k = 0; k < 20_000_000; k++) x = (x * 48271) % 2147483647
  if (x === 0) throw new Error('never')
}
export default async ({ io, gpu, variant }) => {
  const canvas = io.canvas(64, 36)
  const ctx = canvas.getContext('2d')
  if (variant === 'plain')
    return {
      render: async (t) => {
        busy()
        ctx.fillStyle = \`rgb(\${Math.round(t * 200)}, 40, 90)\`
        ctx.fillRect(0, 0, 64, 36)
        return { color: canvas }
      },
    }
  if (variant === 'still') {
    const photo = await io.image('assets/photo.png')
    const big = io.canvas(photo.width, photo.height)
    const pixels = big.getContext('2d').createImageData(photo.width, photo.height)
    pixels.data.set(photo.data)
    big.getContext('2d').putImageData(pixels, 0, 0)
    return {
      render: async () => {
        busy()
        ctx.drawImage(big, 0, 0, 64, 36)
        return { color: canvas }
      },
    }
  }
  if (variant === 'stillGpu') {
    if (!gpu) throw new Error('This variant needs host.gpu.')
    const photo = await io.image('assets/photo.png')
    const big = gpu.createTexture({
      size: [photo.width, photo.height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    })
    gpu.queue.writeTexture({ texture: big }, photo.data, { bytesPerRow: photo.width * 4 }, [photo.width, photo.height])
    const texture = gpu.createTexture({
      size: [64, 36],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    const encoder = gpu.createCommandEncoder()
    encoder.copyTextureToTexture({ texture: big }, { texture }, [64, 36])
    gpu.queue.submit([encoder.finish()])
    return {
      render: async () => {
        busy()
        return { color: texture, alpha: 'opaque' }
      },
    }
  }
  const clip = await io.video('assets/clip.mp4')
  const at = (t) => Math.min(clip.frames - 1, Math.floor(t * clip.fps + 1e-6))
  if (variant === 'fast') {
    if (!gpu) throw new Error('This variant needs host.gpu.')
    const texture = videoTexture(gpu, clip)
    return {
      render: async (t) => {
        busy()
        return { color: await texture.frame(at(t)), alpha: 'opaque' }
      },
    }
  }
  const image = ctx.createImageData(64, 36)
  return {
    render: async (t) => {
      busy()
      image.data.set(await clip.frame(at(t)))
      ctx.putImageData(image, 0, 0)
      return { color: canvas }
    },
  }
}
`,
  )
  spawnSync('ffmpeg', [
    ...['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x36:rate=10', '-frames:v', '10'],
    ...['-pix_fmt', 'yuv420p', join(root, 'assets', 'clip.mp4')],
  ])
  spawnSync('ffmpeg', [
    ...['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=3200x1800', '-frames:v', '1'],
    ...['-pix_fmt', 'rgba', join(root, 'assets', 'photo.png')],
  ])
  return root
}

type Found = { code: string; severity: string; message: string; measured?: string }

test('check notes footage or a large still put on a canvas, never as a failure, and nothing for either on the GPU or a film without them; render advice names the same fix (#508, #773)', {
  skip: !ffmpeg && 'no ffmpeg',
  timeout: 300_000,
}, () => {
  const root = film()
  const json = (args: string[]) => {
    const r = spawnSync(process.execPath, [main, ...args, '--root', root, '--json'], {
      encoding: 'utf8',
    })
    assert.equal(r.status, 0, r.stderr)
    return (JSON.parse(r.stdout) as { findings: Found[] }).findings
  }
  const check = (variant: string) =>
    json(['check', '--samples', '3', '--no-types', '--variant', variant]).filter(
      (f) => f.code === 'footage-draw',
    )
  const fix =
    /io\.video clips and returns a canvas layer.*'yuv420p'.*videoTexture.*guides\/speed\.md, "Footage and stills on the GPU"/
  const slow = check('slow')
  assert.equal(slow.length, 1)
  assert.equal(slow[0]?.severity, 'info')
  assert.match(slow[0]?.message ?? '', fix)
  // A film without stills: no word of them.
  assert.doesNotMatch(slow[0]?.message ?? '', /io.image|maxSize/)
  assert.deepEqual(check('fast'), [])
  assert.deepEqual(check('plain'), [])
  // A large still drawn on the canvas every frame, asked without a maxSize (#773): the note names
  // the stills and maxSize, not clips. The same still written once to a texture: none.
  const still = check('still')
  assert.equal(still.length, 1)
  assert.equal(still[0]?.severity, 'info')
  assert.match(
    still[0]?.message ?? '',
    /^The film opens io.image stills and returns a canvas layer.*upload each still once to a GPU texture.*without a maxSize.*"Footage and stills on the GPU"/,
  )
  assert.doesNotMatch(still[0]?.message ?? '', /io.video|yuv420p/)
  assert.deepEqual(check('stillGpu'), [])
  // Lines too, once, with the exit code a clean check has.
  const lines = spawnSync(
    process.execPath,
    [main, 'check', '--samples', '3', '--no-types', '--variant', 'slow', '--root', root],
    { encoding: 'utf8' },
  )
  assert.equal(lines.status, 0, lines.stderr)
  assert.equal(lines.stdout.match(/^! The film opens io\.video clips/gm)?.length, 1, lines.stdout)

  // The film's own drawing sets the pace of both renders: only the slow one's advice names the fix.
  const advice = (variant: string) => {
    const out = join(tempDir('footage-draw-out'), `${variant}.mp4`)
    const f = json(['render', '--variant', variant, '--out', out, '--no-audio', '--workers', '1'])
    const time = f.find((x) => x.code === 'frame-time')
    assert.ok(time?.measured, JSON.stringify(f))
    assert.equal(JSON.parse(time.measured).drawing, true, time.measured)
    return time.message
  }
  assert.match(advice('slow'), fix)
  const fast = advice('fast')
  assert.match(fast, /own drawing takes most of each frame/)
  assert.doesNotMatch(fast, /io\.video clips|canvas layer|RGBA frames/)
})
