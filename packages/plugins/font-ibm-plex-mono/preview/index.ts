// font-ibm-plex-mono: a type specimen of the three files the plugin installs, Light, Regular and
// SemiBold, set with plain fillText (previews/src/specimen.ts). Three panels, two seconds each,
// drifting slowly up: the weights, the glyphs (Latin, figures, punctuation, accents, Cyrillic) and
// a waterfall of sizes. Nothing here animates the type; the plugin is font files.

import { FONT, type OpenPreview } from '../../previews/src/preview.ts'
import { createSpecimen, LATIN } from '../../previews/src/specimen.ts'

const LIGHT = { family: FONT.monoLight }
const REGULAR = { family: FONT.mono }
const SEMIBOLD = { family: FONT.monoBold }

const fontIbmPlexMono: OpenPreview = async (host, state) => {
  if (state !== 'default') throw new Error(`font-ibm-plex-mono has no state "${state}"`)
  const canvas = host.io.canvas(host.manifest.width, host.manifest.height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const sheet = createSpecimen(host, ctx, {
    title: 'IBM Plex Mono',
    face: REGULAR,
    files: '3 TTF FILES · OFL 1.1',
  })
  const panels = [
    sheet.rows(
      'WEIGHTS',
      [
        { faces: [LIGHT], label: 'LIGHT 300   IBMPlexMono-Light.ttf' },
        { faces: [REGULAR], label: 'REGULAR 400   IBMPlexMono-Regular.ttf' },
        { faces: [SEMIBOLD], label: 'SEMIBOLD 600   IBMPlexMono-SemiBold.ttf' },
      ],
      'Rag 0O 1lI {@}',
    ),
    sheet.glyphs(
      'GLYPHS',
      REGULAR,
      [
        ['LATIN', `${LATIN.upper} ${LATIN.lower}`],
        ['FIGURES AND PUNCTUATION', `${LATIN.figures} ${LATIN.punctuation}`],
        ['ACCENTS', LATIN.accents],
        ['CYRILLIC', LATIN.cyrillic],
      ],
      46,
    ),
    sheet.waterfall('SIZES', REGULAR, '0O 1lI {12,345}', [96, 64, 44, 32, 24, 18, 14]),
  ]
  return {
    async render(t, o) {
      sheet.render(t, o.frame, panels)
      return [{ color: canvas }]
    },
    status: (t) => sheet.at(t, panels).panel.name.toLowerCase(),
    inspect: (t) => ({ id: 'specimen', panel: sheet.at(t, panels).panel.name }),
  }
}

export default fontIbmPlexMono
