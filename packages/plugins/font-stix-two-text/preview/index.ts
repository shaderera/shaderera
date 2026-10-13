// font-stix-two-text: a type specimen of the two variable files the plugin installs, roman and
// italic, set with plain fillText (previews/src/specimen.ts). Three panels, two seconds each,
// drifting slowly up: the four named weights of the wght axis (400, 500, 600, 700) in both styles,
// each held still; the Latin glyphs, figures, punctuation and accents; and the Greek, roman and
// italic. Nothing here animates the type or the axis; the plugin is font files.

import type { OpenPreview } from '../../previews/src/preview.ts'
import { createSpecimen, type Face, LATIN } from '../../previews/src/specimen.ts'

const ROMAN = 'STIX Two Text'
const ITALIC = 'STIX Two Text Italic'
const WEIGHTS = [
  [400, 'REGULAR'],
  [500, 'MEDIUM'],
  [600, 'SEMIBOLD'],
  [700, 'BOLD'],
] as const

const fontStixTwoText: OpenPreview = async (host, state) => {
  if (state !== 'default') throw new Error(`font-stix-two-text has no state "${state}"`)
  await host.io.font('assets/fonts/STIXTwoText[wght].ttf', ROMAN)
  await host.io.font('assets/fonts/STIXTwoText-Italic[wght].ttf', ITALIC)
  const canvas = host.io.canvas(host.manifest.width, host.manifest.height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const roman: Face = { family: ROMAN, wght: 400 }
  const sheet = createSpecimen(host, ctx, {
    title: 'STIX Two Text',
    face: roman,
    files: '2 VARIABLE TTF FILES · WGHT 400–700 · OFL 1.1',
  })
  const rows = WEIGHTS.map(([wght, name]) => ({
    faces: [
      { family: ROMAN, wght },
      { family: ITALIC, wght },
    ],
    label: `${name} ${wght}   ROMAN, ITALIC`,
  }))
  const panels = [
    sheet.rows('WEIGHTS', rows, 'Rag Ωψ 1234', 110),
    sheet.glyphs(
      'LATIN',
      roman,
      [
        ['LATIN', `${LATIN.upper} ${LATIN.lower}`],
        ['FIGURES AND PUNCTUATION', `${LATIN.figures} ${LATIN.punctuation}`],
        ['ACCENTS', LATIN.accents],
      ],
      50,
    ),
    sheet.glyphs(
      'GREEK',
      roman,
      [
        ['ROMAN', LATIN.greek],
        ['ITALIC', LATIN.greek, { family: ITALIC, wght: 400 }],
        ['CYRILLIC', LATIN.cyrillic],
      ],
      50,
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

export default fontStixTwoText
