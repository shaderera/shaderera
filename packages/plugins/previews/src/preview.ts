// The shapes every plugin's preview/ folder has: preview.json (PreviewConfig) and index.ts, whose
// default export is an OpenPreview, the plugin doing its job under the shared caption.

import type { AudioClip, Host, Json, Layer, RenderOptions } from '@shaderera/core'

export type Preview = {
  /** The item's picture, bottom to top; the caption is drawn over it. */
  render(t: number, o: RenderOptions): Promise<Layer[]>
  /** A few words of live state at t, set small at the caption's right (the pass, the bar). */
  status?(t: number): string
  inspect?(t: number): Json
  audio?(): Promise<readonly AudioClip[]>
}

/** A state a visitor can switch to; each is a variant, `<plugin>` the default, `<plugin>.<state>`. */
export type State = { id: string; label: string }

/** A plugin's preview/preview.json. */
export type PreviewConfig = {
  /** One plain sentence: what the plugin does, for someone who has never seen its name. */
  caption: string
  states: readonly State[]
  default: string
  /** Whether the default state's mp4 keeps its sound. */
  audio: boolean
  /** The time of the poster frame (the default state). */
  poster: number
  /** The x264 crf of the mp4s (20 by default); higher for a busy picture, to keep it near 4 MB. */
  crf?: number
}

/** Opens a plugin's preview in one of its states (the states in its preview/preview.json). */
export type OpenPreview = (host: Host, state: string) => Promise<Preview>

/** The families the composition registers with io.font, from the font plugins. */
export const FONT = {
  mono: 'Plex Mono',
  monoBold: 'Plex Mono SemiBold',
  monoLight: 'Plex Mono Light',
  sans: 'Plex Sans',
  sansMedium: 'Plex Sans Medium',
  sansLight: 'Plex Sans Light',
  /** The house's notes (house.ts). */
  serif: 'Instrument Serif Italic',
} as const

export const FONT_FILES: readonly (readonly [string, string])[] = [
  ['assets/fonts/IBMPlexMono-Regular.ttf', FONT.mono],
  ['assets/fonts/IBMPlexMono-SemiBold.ttf', FONT.monoBold],
  ['assets/fonts/IBMPlexMono-Light.ttf', FONT.monoLight],
  ['assets/fonts/IBMPlexSans-Regular.ttf', FONT.sans],
  ['assets/fonts/IBMPlexSans-Medium.ttf', FONT.sansMedium],
  ['assets/fonts/IBMPlexSans-Light.ttf', FONT.sansLight],
  ['assets/fonts/InstrumentSerif-Italic.ttf', FONT.serif],
]
