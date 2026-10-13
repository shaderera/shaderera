// What every preview module exports: the item doing its job, under the shared caption.

import type { AudioClip, Host, Json, Layer, RenderOptions } from '@shaderera/core'

export type Preview = {
  /** The item's picture, bottom to top; the caption is drawn over it. */
  render(t: number, o: RenderOptions): Promise<Layer[]>
  /** A few words of live state at t, set small at the caption's right (the pass, the bar). */
  status?(t: number): string
  inspect?(t: number): Json
  audio?(): Promise<readonly AudioClip[]>
}

/** Opens an item's preview in one of its states (src/items.ts). */
export type OpenPreview = (host: Host, state: string) => Promise<Preview>

/** The families the composition registers with io.font, from the catalog's font items. */
export const FONT = {
  mono: 'Plex Mono',
  monoBold: 'Plex Mono SemiBold',
  monoLight: 'Plex Mono Light',
  sans: 'Plex Sans',
  sansMedium: 'Plex Sans Medium',
  sansLight: 'Plex Sans Light',
} as const

export const FONT_FILES: readonly (readonly [string, string])[] = [
  ['assets/fonts/IBMPlexMono-Regular.ttf', FONT.mono],
  ['assets/fonts/IBMPlexMono-SemiBold.ttf', FONT.monoBold],
  ['assets/fonts/IBMPlexMono-Light.ttf', FONT.monoLight],
  ['assets/fonts/IBMPlexSans-Regular.ttf', FONT.sans],
  ['assets/fonts/IBMPlexSans-Medium.ttf', FONT.sansMedium],
  ['assets/fonts/IBMPlexSans-Light.ttf', FONT.sansLight],
]
