import type { RenderTime } from '../runner/render-time.ts'

/** Where AUTHORING.md says how to draw footage and stills on the GPU. */
const GPU_FOOTAGE = 'AUTHORING.md, "Footage and stills on the GPU"'

/** Where a render's frame time went (#454): what `render` prints at its end, and `--json` holds. */
export type FrameTime = {
  frames: number
  hosts: number
  /** The wall time of the export over its frames, in ms. */
  frameMs: number
  /** A host's render call on average, and of that the wait on io.video frames, in ms. */
  renderMs: number
  videoMs: number
  /** How long a frame waited on average for the encoder to take it, in ms. */
  encoderMs: number
  /** The encoder waited on the frames: writes took at most a quarter of the time. */
  encoderIdle: boolean
  /** The film's own drawing (render without its io.video waits) set the pace. */
  drawing: boolean
}

/**
 * The frame time of an export of `frames` in `wallMs`, whose writes to the encoder took `writeMs`
 * in all, from each host's render time (re-checked and preroll frames are render calls too: the
 * hosts' figures are per call). The drawing sets the pace when the encoder is idle, the drawing
 * outweighs the io.video waits, and on its hosts it fills at least half the wall time.
 */
export const frameTime = (o: {
  frames: number
  wallMs: number
  writeMs: number
  hosts: readonly RenderTime[]
}): FrameTime => {
  const renders = o.hosts.reduce((n, h) => n + h.renders, 0)
  const per = (ms: number) => (renders > 0 ? ms / renders : 0)
  const renderMs = per(o.hosts.reduce((n, h) => n + h.renderMs, 0))
  const videoMs = Math.min(renderMs, per(o.hosts.reduce((n, h) => n + h.videoMs, 0)))
  const frameMs = o.frames > 0 ? o.wallMs / o.frames : 0
  const hosts = Math.max(1, o.hosts.length)
  const encoderIdle = o.writeMs <= o.wallMs / 4
  const own = renderMs - videoMs
  return {
    frames: o.frames,
    hosts: o.hosts.length,
    frameMs,
    renderMs,
    videoMs,
    encoderMs: o.frames > 0 ? o.writeMs / o.frames : 0,
    encoderIdle,
    drawing: encoderIdle && frameMs > 0 && own > videoMs && own / hosts >= frameMs / 2,
  }
}

const ms = (n: number) => `${n.toFixed(1)} ms`

/** One line: `time: 40.0 ms a frame · host render 31.0 ms · waiting on io.video 9.0 ms · encoder idle …`. */
export const frameTimeLine = (t: FrameTime) =>
  `time: ${ms(t.frameMs)} a frame · host render ${ms(t.renderMs)}${t.hosts > 1 ? ` on each of ${t.hosts} hosts` : ''} · waiting on io.video ${ms(t.videoMs)} · ${
    t.encoderIdle
      ? `encoder idle (it took each frame in ${ms(t.encoderMs)} and waited for the next)`
      : `encoder busy (each frame waited ${ms(t.encoderMs)} for it)`
  }`

/** The hint when the film's own drawing sets the pace, or null. */
export const frameTimeHint = (t: FrameTime): string | null =>
  t.drawing
    ? `The film's own drawing takes most of each frame while the encoder waits: footage and stills drawn on the CPU are the usual cause. See ${GPU_FOOTAGE}.`
    : null
