// analysis-web-capture: a page captured by the item's own tool (preview/make.ts runs it on
// preview/page.html), read back through analysis-reference-tracks' reader as a film reads it.
// Above, the page's 1280x720 viewport, scaled, with each tracked element's box as drawn at the
// source time, filled by its opacity and labelled with its rotate; the film's mapping is source
// time = render time, and after 4 s the last sample holds. Below, the card's x against source
// time: one dot per captured frame, and the playhead.

import { createHouse, L, R, RED, type Word } from '../../previews/src/house.ts'
import type { OpenPreview } from '../../previews/src/preview.ts'
import { FONT } from '../../previews/src/preview.ts'
import { at, loadTracks, track } from '../../previews/src/reference/tracks.ts'

const ELEMENTS = ['#bar', '#card', '#dot']
const VIEW = { top: 140, width: 800 }
const GRAPH = { top: 640, bottom: 740 }

const preview: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`analysis-web-capture has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const mono = `"${FONT.mono}"`

  const ref = await loadTracks(host, 'references/web-capture/tracks.json')
  const scale = VIEW.width / ref.frame.width
  const view = { left: L, top: VIEW.top, width: VIEW.width, height: ref.frame.height * scale }
  const channels = (el: string) => ({
    x: track(ref, el, 'x'),
    y: track(ref, el, 'y'),
    width: track(ref, el, 'width'),
    height: track(ref, el, 'height'),
    opacity: track(ref, el, 'opacity'),
    rotate: track(ref, el, 'rotate'),
  })
  const tracked = ELEMENTS.map((el) => ({ el, ...channels(el) }))
  const cardX = track(ref, '#card', 'x')
  const last = cardX.samples.at(-1)?.[0] ?? 0
  const xs = cardX.samples.map(([, v]) => v ?? 0)
  const lo = Math.min(...xs)
  const hi = Math.max(...xs)
  const tx = (s: number) => L + (s / duration) * (R - L)
  const ty = (v: number) => GRAPH.bottom - ((v - lo) / (hi - lo || 1)) * (GRAPH.bottom - GRAPH.top)
  const linear = { between: 'linear', after: 'hold' } as const

  const top: Word[] = [{ from: 0, to: 99, text: 'CAPTURE' }]
  const bottom: Word[] = [
    { from: 0, to: last, text: 'SAMPLED' },
    { from: last, to: 99, text: 'HELD' },
  ]

  return {
    async render(t, o) {
      const s = t
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()

      // The viewport, and each element's box as drawn at source time s.
      ctx.strokeStyle = 'rgba(255,255,255,0.25)'
      ctx.lineWidth = 1
      ctx.strokeRect(view.left + 0.5, view.top + 0.5, view.width - 1, view.height - 1)
      ctx.font = `13px ${mono}`
      ctx.textBaseline = 'alphabetic'
      for (const e of tracked) {
        const [x, y, w, h, a, r] = [e.x, e.y, e.width, e.height, e.opacity, e.rotate].map((q) =>
          at(q, s, linear),
        )
        if (x == null || y == null || w == null || h == null) continue
        const bx = view.left + x * scale
        const by = view.top + y * scale
        ctx.fillStyle = `rgba(255,255,255,${0.85 * (a ?? 1)})`
        ctx.fillRect(bx, by, w * scale, h * scale)
        ctx.strokeStyle = e.el === '#card' ? RED : '#fff'
        ctx.lineWidth = 2
        ctx.strokeRect(bx, by, w * scale, h * scale)
        ctx.fillStyle = '#8a8a8a'
        ctx.textAlign = 'left'
        ctx.fillText(`${e.el}  ${(r ?? 0).toFixed(1)}°  ${(a ?? 0).toFixed(2)}`, bx, by - 10)
      }

      // The card's x, one dot per captured frame.
      for (const [time, v] of cardX.samples) {
        if (v === null) continue
        ctx.fillStyle = time <= s ? '#fff' : 'rgba(255,255,255,0.3)'
        ctx.fillRect(tx(time) - 1.5, ty(v) - 1.5, 3, 3)
      }
      ctx.fillStyle = RED
      ctx.fillRect(tx(Math.min(s, duration)) - 1, GRAPH.top - 14, 2, GRAPH.bottom - GRAPH.top + 28)
      ctx.fillStyle = '#8a8a8a'
      ctx.textAlign = 'left'
      ctx.fillText('#card X  CSS-PX', L, GRAPH.top - 22)
      ctx.textAlign = 'right'
      ctx.fillText('SOURCE TIME', R, GRAPH.bottom + 30)

      house.words(top, bottom, t, o.frame)
      house.note(
        s < last
          ? 'each frame the page reached, read as data'
          : 'after the last frame, the last sample holds',
      )
      const x = at(cardX, s, linear)
      house.hud(
        t,
        o.frame,
        `#card X ${x === null ? 'null' : x.toFixed(1)}`,
        `${cardX.samples.length} FRAMES  ${String(ref.params.fps)} FPS  RAFHZ ${String(ref.params.rafHz)}`,
      )
      return [{ color: canvas }]
    },
    status(t) {
      const x = at(cardX, t, linear)
      return x === null ? 'null' : x.toFixed(1)
    },
    inspect(t) {
      return {
        id: 'web-capture',
        source: t,
        cardX: at(cardX, t, linear),
        frames: cardX.samples.length,
        chrome: String(ref.tool.chrome),
      }
    },
  }
}

export default preview
