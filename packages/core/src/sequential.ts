import type { Manifest, Matrices, RenderOptions, Source } from './protocol.ts'
import { frameAt } from './time.ts'

/** How a sequential source got to the frames asked of it, for reports and tests. */
export type SeekStats = {
  /** The source has `checkpoint`, so seeks restore rather than replay from frame 0. */
  checkpoint: boolean
  /** Times the source was opened (1 + every replay from frame 0). */
  opened: number
  /** Frames the source rendered, including the ones stepped through. */
  rendered: number
  /** Checkpoints saved, restored, and kept now. */
  saved: number
  restored: number
  kept: number
}

export type Seekable = Source & { stats(): SeekStats }

/**
 * What the host resolves for one frame before the source renders it: today the project's DOM
 * drawn at that t (browser host). The seekable source closes the bitmap once the step it was made
 * for has rendered.
 */
export type Prepared = { dom?: ImageBitmap }
export type Prepare = (t: number, signal?: AbortSignal) => Promise<Prepared>

type Checkpoint = { frame: number; state: unknown }

/**
 * A `sequential` source as one the host may call at any t. The source itself only ever renders
 * frames in increasing order, each one after the one before:
 *
 * - `render(t)` first steps, at preview, every frame since the last one it rendered, each with its
 *   own inputs from `prepare` (the DOM at that frame), never the requested frame's.
 * - To go back, or to render the same frame again, the host restores the latest checkpoint at or
 *   before the frame (when the source has `checkpoint`), or opens the source again and replays from
 *   frame 0, then steps forward. Going forward, it restores a checkpoint past the source's frame too.
 * - Checkpoints belong to the inputs the source was opened with. A new camera override is a new
 *   input: the state and every checkpoint are dropped, and the next call replays under it.
 * - Checkpoints are saved after a frame once `checkpointMs` of rendering has passed since the last
 *   one, so a cheap simulation keeps none and an expensive one keeps them spaced by cost. At
 *   `maxCheckpoints`, every other one is dropped and the spacing doubles.
 * - The request's `signal` is checked before and after each prepare and each step: a cancelled
 *   seek stops between frames and leaves the source at the last frame it finished.
 * - `inspect`, `pick` and `camera.get` at t answer about frame t, stepping through the same path.
 *
 * So the source's state must depend only on which frames it rendered and their inputs, never on
 * their intent.
 */
export const seekable = async (
  open: () => Promise<Source>,
  manifest: Manifest,
  o: { prepare?: Prepare; checkpointMs?: number; maxCheckpoints?: number } = {},
): Promise<Seekable> => {
  const { fps, width, height } = manifest
  const lookback =
    manifest.sequential === true || !manifest.sequential ? Infinity : manifest.sequential
  const max = o.maxCheckpoints ?? 32
  let every = o.checkpointMs ?? 250
  const stats: Omit<SeekStats, 'checkpoint'> = {
    opened: 1,
    rendered: 0,
    saved: 0,
    restored: 0,
    kept: 0,
  }
  let source = await open()
  let camera: Matrices | null = null
  /** The last frame the source rendered; -1 for none; Infinity when its state is unknown. */
  let at = -1
  let disposed = false
  /** Rendering time since the last checkpoint (or the open). */
  let spent = 0
  const checkpoints: Checkpoint[] = []
  const frame = (t: number) => frameAt(t, fps)

  /** Renders frame f (at t, which rounds to f), and saves a checkpoint after it when it is due. */
  const step = async (f: number, t: number, options: RenderOptions) => {
    // Until the render resolves, the source's state is unknown: a step that throws (a failure, or
    // a cancelled render) leaves it so, and the next call restores or reopens instead of going on.
    at = Number.POSITIVE_INFINITY
    const start = performance.now()
    const rendered = await source.render(t, { ...options, frame: f })
    at = f
    stats.rendered += 1
    spent += performance.now() - start
    if (source.checkpoint && spent >= every) {
      const { checkpoint } = source
      // A save that is not async works too; any failure, thrown or rejected, names its frame.
      const state = await Promise.resolve()
        .then(() => checkpoint.save())
        .catch((error: unknown) => {
          throw new Error(`checkpoint.save after frame ${f} failed: ${String(error)}`)
        })
      checkpoints.push({ frame: f, state })
      checkpoints.sort((a, b) => a.frame - b.frame)
      stats.saved += 1
      spent = 0
      if (checkpoints.length > max) {
        for (let i = checkpoints.length - 1; i >= 0; i -= 2) checkpoints.splice(i, 1)
        every *= 2
      }
    }
    return rendered
  }

  /**
   * Brings the source through frame `to`, for frame `f` (`to`, or the one after it for a render):
   * restores, reopens or steps, whichever is needed. With a lookback, a fresh source starts at
   * f − lookback instead of frame 0; a jump forward still steps every frame, so that check compares
   * a long history with a short one.
   */
  const reach = async (to: number, signal?: AbortSignal, f = to) => {
    if (disposed) throw new Error('The source was disposed.')
    if (to < -1) throw new Error(`Frame ${to} is before frame 0.`)
    signal?.throwIfAborted()
    const start = Math.max(-1, f - lookback - 1)
    const best = checkpoints.findLast((c) => c.frame <= to && c.frame > start)
    if (best && source.checkpoint && (best.frame > at || at > to)) {
      at = Number.POSITIVE_INFINITY
      // A restore that fails is the participant's error, never a reason to show another state.
      const { checkpoint } = source
      await Promise.resolve()
        .then(() => checkpoint.restore(best.state))
        .catch((error: unknown) => {
          throw new Error(`checkpoint.restore to frame ${best.frame} failed: ${String(error)}`)
        })
      stats.restored += 1
      at = best.frame
      spent = 0
    } else if (at > to) {
      source.dispose?.()
      source = await open()
      stats.opened += 1
      if (camera) source.camera?.override?.(camera)
      at = -1
      spent = 0
    }
    if (at === -1) at = start
    while (at < to) {
      const f = at + 1
      signal?.throwIfAborted()
      const { dom } = (await o.prepare?.(f / fps, signal)) ?? {}
      try {
        signal?.throwIfAborted()
        await step(f, f / fps, {
          width,
          height,
          intent: 'preview',
          frame: f,
          ...(signal ? { signal } : {}),
          ...(dom ? { dom } : {}),
        })
      } finally {
        dom?.close()
      }
    }
  }
  const s = source
  const wrapped: Seekable = {
    render: async (t, options) => {
      const f = frame(t)
      await reach(f - 1, options.signal, f)
      return step(f, t, options)
    },
    dispose: () => {
      disposed = true
      checkpoints.length = 0
      source.dispose?.()
    },
    stats: () => ({ ...stats, checkpoint: !!source.checkpoint, kept: checkpoints.length }),
  }
  if (s.inspect) {
    wrapped.inspect = async (t) => {
      await reach(frame(t))
      return (source.inspect as NonNullable<Source['inspect']>)(t)
    }
  }
  if (s.pick) {
    wrapped.pick = async (t, x, y) => {
      await reach(frame(t))
      return (source.pick as NonNullable<Source['pick']>)(t, x, y)
    }
  }
  if (s.camera) {
    wrapped.camera = {
      get: async (t) => {
        await reach(frame(t))
        return (source.camera as NonNullable<Source['camera']>).get(t)
      },
    }
    if (s.camera.override) {
      wrapped.camera.override = (matrices) => {
        if (JSON.stringify(matrices) === JSON.stringify(camera)) return
        camera = matrices
        source.camera?.override?.(matrices)
        // State made under another camera is not this camera's: replay from frame 0 under it.
        checkpoints.length = 0
        at = Number.POSITIVE_INFINITY
      }
    }
  }
  if (s.audio) wrapped.audio = () => (source.audio as NonNullable<Source['audio']>)()
  return wrapped
}
