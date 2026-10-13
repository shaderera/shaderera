// font-ibm-plex-sans: a type specimen of the three files the plugin installs, Light, Regular and
// Medium, set with plain fillText (previews/src/specimen.ts). Three panels, two seconds each,
// drifting slowly up: the weights, the glyphs (Latin, figures, punctuation, accents, Greek,
// Cyrillic) and a waterfall of sizes. Nothing here animates the type; the plugin is font files.

import { FONT, type OpenPreview } from '../../previews/src/preview.ts'
import { createSpecimen, LATIN } from '../../previews/src/specimen.ts'

const LIGHT = { family: FONT.sansLight }
const REGULAR = { family: FONT.sans }
const MEDIUM = { family: FONT.sansMedium }

const fontIbmPlexSans: OpenPreview = async (host, state) => {
  if (state !== 'default') throw new Error(`font-ibm-plex-sans has no state "${state}"`)
  const canvas = host.io.canvas(host.manifest.width, host.manifest.height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const sheet = createSpecimen(host, ctx, {
    title: 'IBM Plex Sans',
    face: REGULAR,
    files: '3 TTF FILES · OFL 1.1',
  })
  const panels = [
    sheet.rows(
      'WEIGHTS',
      [
        { faces: [LIGHT], label: 'LIGHT 300   IBMPlexSans-Light.ttf' },
        { faces: [REGULAR], label: 'REGULAR 400   IBMPlexSans-Regular.ttf' },
        { faces: [MEDIUM], label: 'MEDIUM 500   IBMPlexSans-Medium.ttf' },
      ],
      'Names, dates 2026',
    ),
    sheet.glyphs(
      'GLYPHS',
      REGULAR,
      [
        ['LATIN', `${LATIN.upper} ${LATIN.lower}`],
        ['FIGURES AND PUNCTUATION', `${LATIN.figures} ${LATIN.punctuation}`],
        ['ACCENTS', LATIN.accents],
        ['GREEK AND CYRILLIC', `${LATIN.greek} ${LATIN.cyrillic}`],
      ],
      40,
    ),
    sheet.waterfall(
      'SIZES',
      REGULAR,
      'Labels, names and dates, 12 March 2026',
      [84, 60, 44, 32, 24, 18, 14],
    ),
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

export default fontIbmPlexSans
