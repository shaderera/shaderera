import type { DeterminismReport, Manifest } from '@shaderera/core'
import { checkDeterminism, diffPixels } from '@shaderera/core'
import { type LightLevels, type SeekStats, sampleTimes } from '@shaderera/core/host'
import { mostLight } from '../deliver/chunks.ts'
import type { Child, ClockReads } from '../node/child.ts'
import { open, parseRendering } from './args.ts'
import { clockWarning } from './clock.ts'
import { EXIT, found } from './findings.ts'

export type CheckResult = DeterminismReport & {
  times: number[]
  what: 'inspect + pixels' | 'pixels'
  msPerFrame: number
  /** In 8-bit RGBA bytes; in 10-bit codes for an hdr10 render's P010. */
  previewVsFinal: { mean: number; max: number; at: number[] }
  /**
   * An hdr10 render (decision 0023): the most light the checked frames reached, each under the
   * mastering display's peak (a frame above it fails the check, naming the frame and the cd/m²).
   */
  light?: LightLevels
  /** A sequential source: how its frames were reached (replays from 0, checkpoint restores). */
  seeks: SeekStats | null
  /** Wall-clock reads inside render (counted, never blocked). */
  clock: ClockReads
}

/** One line on how a sequential source seeks, or none for a source that renders any t. */
export const describeSeeks = (
  s: SeekStats | null,
  sequential: Manifest['sequential'] = true,
): string | null => {
  if (s === null) return null
  const from = sequential === true ? 'frame 0' : `${sequential} frames back`
  return s.checkpoint
    ? `  sequential: stepped in order, seeks back restore checkpoints (${s.restored} restored, ${s.kept} kept, ${s.opened - 1} replays from ${from}, ${s.rendered} frames rendered)`
    : `  sequential, no checkpoint: every seek back replays from ${from} (${s.opened - 1} replays, ${s.rendered} frames rendered)`
}

/** The mean and largest difference of two P010 frames, in 10-bit codes. */
const diffP010 = (a: Uint8Array, b: Uint8Array) => {
  const x = new Uint16Array(a.buffer, a.byteOffset, a.length / 2)
  const y = new Uint16Array(b.buffer, b.byteOffset, b.length / 2)
  if (x.length !== y.length)
    throw new Error(`Cannot compare ${a.length} bytes of P010 with ${b.length}.`)
  let sum = 0
  let max = 0
  for (let i = 0; i < x.length; i++) {
    const d = Math.abs(((x[i] as number) >> 6) - ((y[i] as number) >> 6))
    sum += d
    if (d > max) max = d
  }
  return { mean: x.length ? sum / x.length : 0, max }
}

/**
 * Renders sampled t twice in two orders and compares, plus preview against final at 3 t. A host
 * that renders hdr10 is checked on its P010 bytes (decision 0023), and every frame's light on the
 * way: past the mastering display's peak, or a layer that declares light it cannot carry, fails.
 */
export const checkChild = async (
  child: Child,
  manifest: Manifest,
  o: { times?: number; seed?: number } = {},
): Promise<CheckResult> => {
  const seed = o.seed ?? 1
  const count = o.times ?? 50
  // Fewer than two timestamps compare nothing in two orders: a check that cannot fail.
  if (!(Number.isInteger(count) && count >= 2))
    throw new Error(`--times is a whole number of timestamps, 2 or more, not ${count}.`)
  if (!Number.isFinite(seed)) throw new Error(`--seed is a number, not ${o.seed}.`)
  const times = sampleTimes(manifest.fps, manifest.duration, count, seed)
  const hdr = child.has.p010 === true
  const light: LightLevels[] = []
  const render = async (t: number, intent: 'preview' | 'final') => {
    const r = await child.render(t, intent, hdr ? 'p010' : undefined)
    if (r.light) light.push(r.light)
    return r.pixels
  }
  const start = performance.now()
  const report = await checkDeterminism({
    times,
    seed,
    render: (t) => render(t, 'final'),
    inspect: child.has.inspect ? (t) => child.inspect(t) : undefined,
  })
  const msPerFrame = (performance.now() - start) / (2 * times.length)
  const at = [...new Set([0, Math.floor(times.length / 2), times.length - 1])].map(
    (i) => times[i] as number,
  )
  let mean = 0
  let max = 0
  for (const t of at) {
    const [a, b] = [await render(t, 'preview'), await render(t, 'final')]
    const d = hdr ? diffP010(a, b) : diffPixels(a, b)
    mean = Math.max(mean, d.mean)
    max = Math.max(max, d.max)
  }
  const what = child.has.inspect ? 'inspect + pixels' : 'pixels'
  const seeks = await child.seeks()
  const clock = await child.clock()
  return {
    ...report,
    times,
    what,
    msPerFrame,
    previewVsFinal: { mean, max, at },
    seeks,
    clock,
    ...(hdr ? { light: mostLight(light) } : {}),
  }
}

/**
 * `shaderera check [--times 50] [--seed 1] [--param k=v]... [--hdr10]`. --hdr10: checks the hdr10
 * render (decision 0023): its P010 bytes, the peak and the layers' light.
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const { values: v } = parseRendering(
    argv,
    { times: { type: 'string' }, seed: { type: 'string' }, hdr10: { type: 'boolean' } },
    { command: 'check', times: false },
  )
  const { project, child } = await open(v)
  try {
    const r = await checkChild(child, project.manifest, {
      times: Number(v.times ?? 50),
      seed: Number(v.seed ?? 1),
    })
    const { mean, max, at } = r.previewVsFinal
    const compare = `  preview vs final: mean ${mean.toFixed(3)}, max ${max}${r.light ? ' 10-bit codes' : ''} over ${at.length} t`
    const peak = project.manifest.hdr10?.mastering.peak
    const hdr = r.light
      ? `  HDR10: P010 hashed; at most ${Number(r.light.maxCll.toFixed(2))} cd/m² (MaxCLL) and a frame average of ${Number(r.light.maxFall.toFixed(2))} cd/m² (MaxFALL), within the mastering display's ${peak} cd/m²`
      : undefined
    if (r.failures.length === 0) {
      console.log(
        `✓ deterministic: ${r.times.length} timestamps, two orders, ${r.what} (${r.msPerFrame.toFixed(1)} ms/frame)`,
      )
      console.log(compare)
      if (hdr) console.log(hdr)
      const seeks = describeSeeks(r.seeks, project.manifest.sequential)
      if (seeks) console.log(seeks)
      const warning = clockWarning(r.clock)
      if (warning) {
        console.log(`! ${warning}`)
        found({ code: 'clock', severity: 'warning', message: warning })
      }
      return EXIT.ok
    }
    console.log(`✗ not deterministic: ${r.failures.length} of ${r.times.length} timestamps differ`)
    for (const f of r.failures) {
      const detail =
        f.kind === 'inspect'
          ? f.changes
              .slice(0, 5)
              .map((c) => c.path)
              .join(', ')
          : `${f.first.slice(0, 12)} != ${f.second.slice(0, 12)}`
      console.log(`  ✗ t=${f.t} after t=${f.after ?? '-'} ${f.kind}: ${detail}`)
      found({
        code: 'determinism',
        severity: 'error',
        message: `t=${f.t} after t=${f.after ?? '-'} ${f.kind}: ${detail}`,
        t: [f.t],
      })
    }
    console.log(compare)
    const seeks = describeSeeks(r.seeks, project.manifest.sequential)
    if (seeks) console.log(seeks)
    const warning = clockWarning(r.clock)
    if (warning) {
      console.log(`! ${warning}`)
      found({ code: 'clock', severity: 'warning', message: warning })
    }
    return EXIT.failed
  } finally {
    await child.close()
  }
}
