// Where a host's render time goes (#454, #497), the same in both hosts: how long the source's
// render calls took, for how much of that time an `io.video` frame was awaited, and how long each
// frame then took to be composited, read back and handed over. `render` prints it at the end.

/**
 * A host's render calls since the last reset: how many, their time, their io.video waits, and the
 * compositor, readback and hand-off of their frames.
 */
export type RenderTime = { renders: number; renderMs: number; videoMs: number; composeMs: number }

// Read before the hosts count the wall-clock reads inside render (host.ts, worker.ts): this
// module's imports run first, so its own reads are never counted as the film's.
const now = performance.now.bind(performance)

const state = {
  renders: 0,
  renderMs: 0,
  videoMs: 0,
  composeMs: 0,
  rendering: false,
  /** io.video frames asked for and not yet come. */
  outstanding: 0,
  /** Since when a frame has been outstanding inside the current render, or null. */
  since: null as number | null,
  /** The next render call is not counted: the first after a reset compiles its shaders. */
  skip: false,
}

/** Adds the waiting since `since` (a wait inside render that is still running) and stops it. */
const settle = () => {
  if (state.since !== null && !state.skip) state.videoMs += now() - state.since
  state.since = null
}

/** The render calls timed since the last reset. */
export const renderTime = (): RenderTime => ({
  renders: state.renders,
  renderMs: state.renderMs,
  videoMs: state.videoMs,
  composeMs: state.composeMs,
})

/**
 * Starts the figures again (an export, after its preroll): what a kept host rendered before is
 * not this one's, and the next render call, which compiles the film's shaders, is left out.
 */
export const resetRenderTime = () => {
  state.renders = 0
  state.renderMs = 0
  state.videoMs = 0
  state.composeMs = 0
  state.skip = true
}

/** Runs one of the source's render calls, timed. */
export const timeRender = async <T>(run: () => Promise<T>): Promise<T> => {
  const start = now()
  state.rendering = true
  if (state.outstanding > 0) state.since = start
  try {
    return await run()
  } finally {
    settle()
    state.rendering = false
    if (state.skip) state.skip = false
    else {
      state.renders++
      state.renderMs += now() - start
    }
  }
}

/**
 * Waits on an io.video frame. The time counted is the union of the waits inside render: two
 * frames awaited at once count once, and a frame asked ahead counts only while a render runs.
 */
export const timeVideo = async <T>(wait: () => Promise<T>): Promise<T> => {
  if (state.outstanding++ === 0 && state.rendering) state.since = now()
  try {
    return await wait()
  } finally {
    if (--state.outstanding === 0) settle()
  }
}

/**
 * Times one frame: its render call (timeRender), then from the call's end to `done()` (the frame
 * composited, read back and handed over) as its compositor's time. The frame whose render call is
 * left out (the first after a reset) is left out here too.
 */
export const timeFrame = () => {
  let ended: number | null = null
  let counted = false
  return {
    render: async <T>(run: () => Promise<T>): Promise<T> => {
      counted = !state.skip
      try {
        return await timeRender(run)
      } finally {
        ended = now()
      }
    },
    done: () => {
      if (ended !== null && counted) state.composeMs += now() - ended
      ended = null
    },
  }
}
