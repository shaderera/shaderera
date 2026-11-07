import type { Drawn, RenderTime } from '../runner/render-time.ts'

/** Where the speed guide says how to draw footage and stills on the GPU. */
export const GPU_FOOTAGE = 'guides/speed.md, "Footage and stills on the GPU"'
/** Where the speed guide says when more hosts render faster. */
const MORE_HOSTS = 'guides/speed.md, "Expensive films"'

/**
 * Where a render's frame time went (#454, #497): what `render` prints at its end, and `--json`
 * holds. While the encoder is idle, a host's parts (its drawing, io.video waits, compositor and
 * readback) over the hosts, plus the encoder's, add up to the frame time within a quarter of it
 * (docs/cli.md, "Where the time went"); a busy encoder's wait overlaps the hosts' work.
 */
export type FrameTime = {
  frames: number
  hosts: number
  /** The wall time of the export over its frames, in ms. */
  frameMs: number
  /** A host's render call on average, and of that the wait on io.video frames, in ms. */
  renderMs: number
  videoMs: number
  /** A host's compositor, readback and hand-off of the frame after the render call, in ms. */
  composeMs: number
  /** How long a frame waited on average for the encoder to take it, in ms. */
  encoderMs: number
  /** The encoder waited on the frames: writes took at most a quarter of the time. */
  encoderIdle: boolean
  /** The film's own drawing (render without its io.video waits) set the pace. */
  drawing: boolean
  /** The compositor, readback and hand-off set the pace. */
  compositor: boolean
}

/**
 * The frame time of an export of `frames` in `wallMs`, whose writes to the encoder took `writeMs`
 * in all, from each host's render time (re-checked and preroll frames are render calls too: the
 * hosts' figures are per call). A host's part sets the pace when the encoder is idle, it is the
 * largest of the drawing, the io.video waits and the compositor, and on its hosts it fills at least
 * half the wall time.
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
  const composeMs = per(o.hosts.reduce((n, h) => n + h.composeMs, 0))
  const frameMs = o.frames > 0 ? o.wallMs / o.frames : 0
  const hosts = Math.max(1, o.hosts.length)
  const encoderIdle = o.writeMs <= o.wallMs / 4
  const own = renderMs - videoMs
  const paces = (ms: number, ...others: number[]) =>
    encoderIdle && frameMs > 0 && others.every((n) => ms > n) && ms / hosts >= frameMs / 2
  return {
    frames: o.frames,
    hosts: o.hosts.length,
    frameMs,
    renderMs,
    videoMs,
    composeMs,
    encoderMs: o.frames > 0 ? o.writeMs / o.frames : 0,
    encoderIdle,
    drawing: paces(own, videoMs, composeMs),
    compositor: paces(composeMs, own, videoMs),
  }
}

const ms = (n: number) => `${n.toFixed(1)} ms`

/** One line: `time: 40.0 ms a frame · on the host: drawing 22.0 ms, compositor and readback 7.0 ms, …`. */
export const frameTimeLine = (t: FrameTime) =>
  `time: ${ms(t.frameMs)} a frame · ${t.hosts > 1 ? `on each of ${t.hosts} hosts` : 'on the host'}: drawing ${ms(t.renderMs - t.videoMs)}, compositor and readback ${ms(t.composeMs)}, waiting on io.video ${ms(t.videoMs)} · ${
    t.encoderIdle
      ? `encoder idle (it took each frame in ${ms(t.encoderMs)} and waited for the next)`
      : `encoder busy (each frame waited ${ms(t.encoderMs)} for it)`
  }`

/**
 * The slow way a film draws its footage, and the fast way (#508), or null: it opens io.video clips
 * and returns a canvas layer, or asks for their frames as RGBA while it returns GPU layers. `check`
 * notes it, and `render` names it when the drawing or the compositor sets the pace, on a host with
 * a GPU compositor (`has.deep`).
 */
export const footageFix = (d: Drawn): string | null =>
  d.clips && d.canvas
    ? `The film opens io.video clips and returns a canvas layer, which is uploaded every frame: ask for the clips' frames as 'yuv420p', draw them with videoTexture (@shaderera/core/gpu) on host.gpu, and return GPU textures. See ${GPU_FOOTAGE}.`
    : d.clips && d.rgba && d.gpu
      ? `The film asks io.video for RGBA frames while it returns GPU layers: ask for 'yuv420p' and convert them with videoTexture (@shaderera/core/gpu), 1.5 bytes a pixel, not 4. See ${GPU_FOOTAGE}.`
      : null

/**
 * The hint naming the host's part that sets the pace, or null. `drawn`, how the film drew on its
 * hosts: with clips or a canvas layer, the hint names the fast way to draw them (footageFix). While
 * the encoder is idle and no one part sets the pace (the io.video waits lead, or the parts are
 * even), a film that draws its footage the slow way still gets footageFix: it makes all three
 * smaller (#771).
 */
export const frameTimeHint = (t: FrameTime, drawn?: Drawn): string | null => {
  const fix =
    drawn &&
    (footageFix(drawn) ??
      (drawn.canvas
        ? `The film returns a canvas layer, which is uploaded every frame: draw on host.gpu and return a GPU texture. See ${GPU_FOOTAGE}.`
        : null))
  return t.drawing
    ? fix
      ? `The film's own drawing takes most of each frame while the encoder waits. ${fix}`
      : `The film's own drawing takes most of each frame while the encoder waits: footage and stills drawn on the CPU are the usual cause. See ${GPU_FOOTAGE}.`
    : t.compositor
      ? `The compositor and readback take most of each frame while the encoder waits: every frame's layers are composited, read back and handed to the CLI on its host, so more hosts (--workers) on idle cores, fewer layers, and layers as GPU textures rather than canvases make it faster. See ${MORE_HOSTS}.${fix ? ` ${fix}` : ''}`
      : t.encoderIdle && t.frameMs > 0 && drawn && footageFix(drawn)
        ? `The hosts take each frame while the encoder waits. ${footageFix(drawn)}`
        : null
}

/** How the film drew on any of its hosts (Drawn), or undefined when a host could not say. */
export const drawnOn = (hosts: readonly ({ drawn?: Drawn } | undefined)[]): Drawn | undefined =>
  hosts.every((h) => h?.drawn)
    ? hosts.reduce<Drawn>(
        (all, h) => {
          const d = h?.drawn as Drawn
          return {
            clips: all.clips || d.clips,
            rgba: all.rgba || d.rgba,
            canvas: all.canvas || d.canvas,
            gpu: all.gpu || d.gpu,
          }
        },
        { clips: false, rgba: false, canvas: false, gpu: false },
      )
    : undefined
