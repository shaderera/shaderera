// text-feature-captions: the plugin's captions on plain black, eight to a loop, one every two
// beats at 160 BPM, its notes in Instrument Serif Italic as the house style sets them. Everything
// in the picture is the plugin's: the titles, the notes, the running count, the hollow numeral,
// the hairlines and the edge layout's ruler. In the 'all' state each caption is set in the next
// of the four layouts (edge, split, column, spine); a state keeps every caption in one. The
// captions run from a loop before to a loop after, so every change, the seam included, is the
// plugin's swap through ASCII noise.

import { createHouse, SERIF } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'
import type { Layout } from '../../previews/src/type/captions.ts'
import { createCaptions } from '../../previews/src/type/captions.ts'

const SWAP = (2 * 60) / 160
const PICTURE = 904
const ITEMS: [string, string][] = [
  ['HUGE TITLES', 'a small note beside each'],
  ['ON THE BEAT', 'two beats a caption'],
  ['THROUGH NOISE', 'every swap decodes in ASCII'],
  ['FOUR LAYOUTS', 'edge, split, column, spine'],
  ['SAFE AREA', 'inside the title-safe margins'],
  ['HOLLOW NUMBERS', 'the count, huge, behind'],
  ['ANY FORMAT', 'square, wide or tall'],
  ['NAME IT', 'say what the picture is doing'],
]
const LAYOUTS: Record<string, Layout[]> = {
  all: ['edge', 'split', 'column', 'spine'],
  edge: ['edge'],
  split: ['split'],
  column: ['column'],
  spine: ['spine'],
}

const textFeatureCaptions: OpenPreview = async (host, stateId) => {
  const layouts = LAYOUTS[stateId]
  if (!layouts) throw new Error(`text-feature-captions has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const theme = createHouse(host, ctx)
  const picture = host.io.canvas(width, PICTURE)
  const pctx = picture.getContext('2d') as OffscreenCanvasRenderingContext2D
  const captions = createCaptions({
    captions: [{ from: -duration, to: 2 * duration, items: ITEMS }],
    fonts: { title: `"${FONT.monoBold}"`, small: `"${FONT.mono}"`, note: `"${SERIF}"` },
    swap: SWAP,
    layouts,
  })

  const state = (t: number) => {
    const n = Math.floor(t / SWAP)
    const index = ((n % ITEMS.length) + ITEMS.length) % ITEMS.length
    return { index, layout: layouts[index % layouts.length] ?? 'edge' }
  }

  return {
    async render(t, o) {
      // The captions above the caption band, as the README calls them, on a cleared layer.
      pctx.clearRect(0, 0, width, PICTURE)
      captions(pctx, width, PICTURE, t, o.frame)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(picture, 0, 0)
      const st = state(t)
      theme.hud(
        t,
        o.frame,
        `${String(st.index + 1).padStart(2, '0')}/08 ${st.layout.toUpperCase()}`,
        '',
        'top-right',
      )
      return [{ color: canvas }]
    },
    status(t) {
      const s = state(t)
      return `${String(s.index + 1).padStart(2, '0')}/08  ${s.layout}`
    },
    inspect(t) {
      const s = state(t)
      const [title, note] = ITEMS[s.index] ?? ['', '']
      return { id: 'caption', index: s.index, layout: s.layout, title, note }
    },
  }
}

export default textFeatureCaptions
