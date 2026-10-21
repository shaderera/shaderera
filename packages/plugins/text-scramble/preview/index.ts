// text-scramble: the plugin's three primitives on plain white text, one at a time, each labelled
// with its call. Three rows show one primitive at three settings: scramble at three shares,
// decoded at three rises and falls, glitched at three amounts. In the 'all' state each primitive
// holds 2 s, with a hard cut to the next; a state shows one primitive on four words, 1.5 s each.
// The font is a family only, as the plugin's calls take it: '"Plex Mono SemiBold"'.

import { createHouse, L, type Word } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'
import { decoded, glitched, scramble } from '../../previews/src/type/scramble.ts'

type Primitive = 'scramble' | 'decode' | 'glitch'
type Slot = { id: Primitive; text: string }

const STATES: Record<string, Slot[]> = {
  all: [
    { id: 'scramble', text: 'SCRAMBLE' },
    { id: 'decode', text: 'DECODE' },
    { id: 'glitch', text: 'GLITCH' },
  ],
  scramble: [
    { id: 'scramble', text: 'SCRAMBLE' },
    { id: 'scramble', text: 'EVERY' },
    { id: 'scramble', text: 'LETTER' },
    { id: 'scramble', text: 'ASCII' },
  ],
  decode: [
    { id: 'decode', text: 'DECODE' },
    { id: 'decode', text: 'INTO' },
    { id: 'decode', text: 'PLACE' },
    { id: 'decode', text: 'LETTERS' },
  ],
  glitch: [
    { id: 'glitch', text: 'GLITCH' },
    { id: 'glitch', text: 'THE' },
    { id: 'glitch', text: 'SIGNAL' },
    { id: 'glitch', text: 'BANDS' },
  ],
}

/** Each primitive: its name, what it varies, a note, and the three settings with their labels. */
const PRIMITIVES: Record<Primitive, { name: string; varies: string; note: string }> = {
  scramble: {
    name: 'SCRAMBLE',
    varies: 'SHARE',
    note: 'a share of the letters, new noise every frame',
  },
  decode: { name: 'DECODED', varies: 'RISE / FALL', note: 'in letter by letter, out the same way' },
  glitch: { name: 'GLITCHED', varies: 'AMOUNT', note: 'bands thrown sideways, new every frame' },
}
const SHARES = [0.1, 0.35, 0.7]
const DECODES = [
  { rise: 0.3, fall: 0.15 },
  { rise: 0.6, fall: 0.3 },
  { rise: 0.9, fall: 0.45 },
]
const AMOUNTS = [0.25, 0.6, 1]
/** The rows: the top of the first, the pitch, and the largest size. */
const ROW = { top: 172, pitch: 200, size: 130 }

const textScramble: OpenPreview = async (host, stateId) => {
  const slots = STATES[stateId]
  if (!slots) throw new Error(`text-scramble has no state "${stateId}"`)
  const first = slots[0] as Slot
  const { width, height, duration } = host.manifest
  const STEP = duration / slots.length
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const font = `"${FONT.monoBold}"`
  const mono = `"${FONT.mono}"`

  // The corner words and notes: one per slot in 'all', one for the loop in a state.
  const single = stateId !== 'all'
  const spans = (pick: (s: Slot) => string): Word[] =>
    single
      ? [{ from: 0, to: duration, text: pick(first) }]
      : slots.map((s, i) => ({ from: i * STEP, to: (i + 1) * STEP, text: pick(s) }))
  const TOPS = spans((s) => PRIMITIVES[s.id].name)
  const BOTTOMS = spans((s) => PRIMITIVES[s.id].varies)
  const NOTES = spans((s) => PRIMITIVES[s.id].note)

  const state = (t: number) => {
    const n = Math.floor(t / STEP)
    return { n, slot: slots[n % slots.length] ?? first, from: n * STEP, to: (n + 1) * STEP }
  }

  const label = (text: string, y: number) => {
    ctx.font = `16px ${mono}`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = '#9a9a9a'
    ctx.fillText(text, L, y)
  }

  return {
    async render(t, o) {
      const s = state(t)
      const { slot } = s
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()

      const size = ROW.size
      for (let j = 0; j < 3; j++) {
        const top = ROW.top + j * ROW.pitch
        const mid = top + 40 + size * 0.5
        let text = slot.text
        let amount = 0
        if (slot.id === 'scramble') {
          const share = SHARES[j] ?? 0
          label(`scramble(text, frame, ${share.toFixed(2)})`, top + 16)
          text = scramble(slot.text, o.frame + j * 7, share)
        } else if (slot.id === 'decode') {
          const d = DECODES[j] ?? { rise: 0.3, fall: 0.15 }
          label(
            `decoded(text, t, { from, to, rise: ${d.rise.toFixed(2)}, fall: ${d.fall.toFixed(2)} })`,
            top + 16,
          )
          text = decoded(slot.text, t, {
            from: s.from,
            to: s.to,
            frame: o.frame,
            seed: s.n * 3 + j,
            ...d,
          }).text
        } else {
          amount = AMOUNTS[j] ?? 1
          label(`glitched(ctx, text, x, y, { amount: ${amount.toFixed(2)} })`, top + 16)
        }
        ctx.fillStyle = '#fff'
        glitched(ctx, text, L, mid, { font, size, frame: o.frame + j * 11, amount })
      }

      house.words(TOPS, BOTTOMS, t, o.frame)
      house.notes(NOTES, t, o.frame)
      house.hud(t, o.frame, `SIZE ${size} PX`, `FONT ${font.toUpperCase()}`)
      return [{ color: canvas }]
    },
    status(t) {
      const s = state(t)
      return `${String((s.n % slots.length) + 1).padStart(2, '0')}/${String(slots.length).padStart(2, '0')}  ${s.slot.id}`
    },
    inspect(t) {
      const s = state(t)
      return { id: 'scramble', primitive: s.slot.id, text: s.slot.text }
    },
  }
}

export default textScramble
