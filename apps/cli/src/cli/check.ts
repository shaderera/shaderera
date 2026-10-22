import type { DeterminismReport, Manifest } from '@shaderera/core'
import { checkDeterminism, diffPixels } from '@shaderera/core'
import { type SeekStats, sampleTimes } from '@shaderera/core/host'
import type { Child, ClockReads } from '../node/child.ts'
import { open, parseRendering } from './args.ts'
import { clockWarning } from './clock.ts'
import { EXIT } from './findings.ts'
import { eachVariant, type Output } from './variants.ts'

export type CheckResult = DeterminismReport & {
  times: number[]
  what: 'inspect + pixels' | 'pixels'
  msPerFrame: number
  previewVsFinal: { mean: number; max: number; at: number[] }
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

/** Renders sampled t twice in two orders and compares, plus preview against final at 3 t. */
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
  const start = performance.now()
  const report = await checkDeterminism({
    times,
    seed,
    render: async (t) => (await child.render(t, 'final')).pixels,
    inspect: child.has.inspect ? (t) => child.inspect(t) : undefined,
  })
  const msPerFrame = (performance.now() - start) / (2 * times.length)
  const at = [...new Set([0, Math.floor(times.length / 2), times.length - 1])].map(
    (i) => times[i] as number,
  )
  let mean = 0
  let max = 0
  for (const t of at) {
    const d = diffPixels(
      (await child.render(t, 'preview')).pixels,
      (await child.render(t, 'final')).pixels,
    )
    mean = Math.max(mean, d.mean)
    max = Math.max(max, d.max)
  }
  const what = child.has.inspect ? 'inspect + pixels' : 'pixels'
  const seeks = await child.seeks()
  const clock = await child.clock()
  return { ...report, times, what, msPerFrame, previewVsFinal: { mean, max, at }, seeks, clock }
}

/**
 * `shaderera check [--times 50] [--seed 1] [--param k=v]... [--variant a,b | --variants all]`: each
 * variant in its own host, at once (eachVariant).
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const { values } = parseRendering(
    argv,
    { times: { type: 'string' }, seed: { type: 'string' }, variants: { type: 'string' } },
    { command: 'check', times: false },
  )
  return eachVariant(values, checkOne)
}

const checkOne = async (
  v: Parameters<typeof open>[0] & { times?: string; seed?: string },
  out: Output,
): Promise<number> => {
  const { project, child } = await open(v)
  try {
    const r = await checkChild(child, project.manifest, {
      times: Number(v.times ?? 50),
      seed: Number(v.seed ?? 1),
    })
    const { mean, max, at } = r.previewVsFinal
    const compare = `  preview vs final: mean ${mean.toFixed(3)}, max ${max} over ${at.length} t`
    if (r.failures.length === 0) {
      out.log(
        `✓ deterministic: ${r.times.length} timestamps, two orders, ${r.what} (${r.msPerFrame.toFixed(1)} ms/frame)`,
      )
      out.log(compare)
      const seeks = describeSeeks(r.seeks, project.manifest.sequential)
      if (seeks) out.log(seeks)
      const warning = clockWarning(r.clock)
      if (warning) {
        out.log(`! ${warning}`)
        out.found({ code: 'clock', severity: 'warning', message: warning })
      }
      return EXIT.ok
    }
    out.log(`✗ not deterministic: ${r.failures.length} of ${r.times.length} timestamps differ`)
    for (const f of r.failures) {
      const detail =
        f.kind === 'inspect'
          ? f.changes
              .slice(0, 5)
              .map((c) => c.path)
              .join(', ')
          : `${f.first.slice(0, 12)} != ${f.second.slice(0, 12)}`
      out.log(`  ✗ t=${f.t} after t=${f.after ?? '-'} ${f.kind}: ${detail}`)
      out.found({
        code: 'determinism',
        severity: 'error',
        message: `t=${f.t} after t=${f.after ?? '-'} ${f.kind}: ${detail}`,
        t: [f.t],
      })
    }
    out.log(compare)
    const seeks = describeSeeks(r.seeks, project.manifest.sequential)
    if (seeks) out.log(seeks)
    const warning = clockWarning(r.clock)
    if (warning) {
      out.log(`! ${warning}`)
      out.found({ code: 'clock', severity: 'warning', message: warning })
    }
    return EXIT.failed
  } finally {
    await child.close()
  }
}
