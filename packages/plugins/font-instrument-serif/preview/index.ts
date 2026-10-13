// font-instrument-serif: a type specimen of the two files the plugin installs, roman and italic,
// set with plain fillText (previews/src/specimen.ts). Three panels, two seconds each, drifting
// slowly up: both styles set large, then the roman's glyphs and the italic's (Latin, figures,
// punctuation, accents). Nothing here animates the type; the plugin is font files.

import type { OpenPreview } from '../../previews/src/preview.ts'
import { createSpecimen, LATIN } from '../../previews/src/specimen.ts'

const ROMAN = { family: 'Instrument Serif' }
/** Registered by the previews' composition for the house's notes. */
const ITALIC = { family: 'Instrument Serif Italic' }
const GROUPS = [
  ['LATIN', `${LATIN.upper} ${LATIN.lower}`],
  ['FIGURES AND PUNCTUATION', `${LATIN.figures} ${LATIN.punctuation}`],
  ['ACCENTS', LATIN.accents],
] as const

const fontInstrumentSerif: OpenPreview = async (host, state) => {
  if (state !== 'default') throw new Error(`font-instrument-serif has no state "${state}"`)
  await host.io.font('assets/fonts/InstrumentSerif-Regular.ttf', ROMAN.family)
  const canvas = host.io.canvas(host.manifest.width, host.manifest.height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const sheet = createSpecimen(host, ctx, {
    title: 'Instrument Serif',
    face: ROMAN,
    files: '2 TTF FILES · OFL 1.1',
  })
  const panels = [
    sheet.display(
      'ROMAN AND ITALIC',
      [
        { face: ROMAN, label: 'ROMAN   InstrumentSerif-Regular.ttf', text: 'Editorial' },
        { face: ITALIC, label: 'ITALIC   InstrumentSerif-Italic.ttf', text: 'display' },
      ],
      250,
    ),
    sheet.glyphs('ROMAN GLYPHS', ROMAN, GROUPS, 56),
    sheet.glyphs('ITALIC GLYPHS', ITALIC, GROUPS, 56),
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

export default fontInstrumentSerif
