// The previews as data: each item's caption and the states a visitor can switch between. The
// composition opens src/<item>.ts with one of these states; scripts/render.ts renders every state
// and writes this into out/<item>/preview.json for the website. Each state is a variant in
// shaderera.json: `<item>` is the default state, `<item>.<state>` the others.

export type State = { id: string; label: string }
export type Item = {
  /** One plain sentence: what the item does, for someone who has never seen its name. */
  caption: string
  states: readonly State[]
  default: string
  audio: boolean
  /** The time of the poster frame (the default state). */
  poster: number
}

export const ITEMS: Record<string, Item> = {
  'look-screen-passes': {
    caption:
      'Turns any frame into ASCII, halftone, dither, heat map, contours, pixels or glitch, in one GPU pass.',
    states: [
      { id: 'all', label: 'All passes' },
      { id: 'ascii', label: 'ASCII' },
      { id: 'halftone', label: 'Halftone' },
      { id: 'off', label: 'Off' },
    ],
    default: 'all',
    audio: false,
    poster: 3.6,
  },
  'text-kinetic': {
    caption:
      'Type that scrambles, decodes into place, glitches and sizes itself to fit, in Canvas2D.',
    states: [
      { id: 'all', label: 'All' },
      { id: 'scramble', label: 'Scramble' },
      { id: 'decode', label: 'Decode' },
      { id: 'glitch', label: 'Glitch' },
    ],
    default: 'all',
    audio: false,
    poster: 3.62,
  },
  'audio-beat-clock': {
    caption:
      "Measures a song's tempo, bars, hits and bass-to-treble levels, so picture and lyrics land on the beat.",
    states: [
      { id: 'all', label: 'All' },
      { id: 'bands', label: 'Bands' },
      { id: 'grid', label: 'Beat grid' },
      { id: 'lyrics', label: 'Lyrics' },
    ],
    default: 'all',
    audio: true,
    poster: 2.3,
  },
}

/** The variant that renders an item in a state. */
export const variantOf = (item: string, state: string) =>
  state === ITEMS[item]?.default ? item : `${item}.${state}`
