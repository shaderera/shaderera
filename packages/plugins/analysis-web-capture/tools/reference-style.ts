// The writer of reference-style artifacts: the same facts give the same bytes, so two captures of
// one page can be compared byte for byte.
//   import { styleJson } from './reference-style.ts'
//   writeFileSync('references/hero/style.json', styleJson({ format, kind, source, ... }))
//
// - Keys come in one order: the header (format, kind, source, tool, params), then frame, scroll,
//   screenshot, elements, texts, fontFaces and limits. An element is element, dataId, tag,
//   pseudoElement, box, paintOrder, styles (in params.styles' order), then any field a later
//   capture adds; a text is element, pseudoElement, child, text, boxes, fonts. Elsewhere keys are
//   sorted by code unit.
// - Elements and texts keep their order (document order); a text's fonts are sorted by family,
//   PostScript name and whether they are custom; font faces by family, then src.
// - Box numbers are rounded to BOX_DIGITS decimals. Chrome lays out in 1/64 px, which they hold.
// - It refuses what loadStyle would refuse. A top-level field it does not know is refused.

import type { ReferenceStyle } from '../src/reference/style.ts'
import { styleProblem } from '../src/reference/style.ts'
import { ordered, round, sorted, sourceJson } from './reference-tracks.ts'

/** Decimals kept in a box's numbers, in CSS pixels. */
export const BOX_DIGITS = 6

/** What a capture hands the writer: an artifact without the path it is read from. */
export type StyleDoc = Omit<ReferenceStyle, 'path'>

const TOP = [
  'format',
  'kind',
  'source',
  'tool',
  'params',
  'frame',
  'scroll',
  'screenshot',
  'elements',
  'texts',
  'fontFaces',
  'limits',
]
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const json = (v: unknown, indent: string) =>
  JSON.stringify(v, null, 2).replaceAll('\n', `\n${indent}`)
const box = (b: number[]) => b.map((v) => round(v, BOX_DIGITS))
const lines = (name: string, rows: unknown[]) =>
  `"${name}": [${rows.length > 0 ? `\n${rows.map((r) => `    ${JSON.stringify(r)}`).join(',\n')}\n  ` : ''}]`

/**
 * The artifact as the bytes to write: in a stable order, one element and one text per line, with
 * a final newline. Refuses a document loadStyle would refuse, naming what is wrong.
 */
export const styleJson = (doc: StyleDoc): string => {
  const extra = Object.keys(doc).filter((k) => !TOP.includes(k))
  if (extra.length > 0)
    throw new Error(`reference-style has no field ${extra.join(', ')}: put it in params or tool`)
  const wrong = styleProblem(doc, 'the reference style')
  if (wrong) throw new Error(wrong)
  const S = "the reference style's "
  const elements = doc.elements.map((e, i) =>
    ordered(
      { ...e, box: box(e.box) },
      ['element', 'dataId', 'tag', 'pseudoElement', 'box', 'paintOrder', 'styles'],
      `${S}elements[${i}]`,
    ),
  )
  const texts = doc.texts.map((t, i) =>
    ordered(
      {
        ...t,
        boxes: t.boxes.map((b, j) =>
          ordered(
            { ...b, box: box(b.box) },
            ['box', 'start', 'length'],
            `${S}texts[${i}].boxes[${j}]`,
          ),
        ),
        fonts: [...t.fonts]
          .sort(
            (a, b) =>
              byCode(a.familyName, b.familyName) ||
              byCode(a.postScriptName, b.postScriptName) ||
              Number(a.isCustomFont) - Number(b.isCustomFont),
          )
          .map((g, j) =>
            ordered(
              g,
              ['familyName', 'postScriptName', 'isCustomFont', 'glyphCount'],
              `${S}texts[${i}].fonts[${j}]`,
            ),
          ),
      },
      ['element', 'pseudoElement', 'child', 'text', 'boxes', 'fonts'],
      `${S}texts[${i}]`,
    ),
  )
  const faces = [...doc.fontFaces]
    .map((f, i) => sorted(f, `${S}fontFaces[${i}]`))
    .sort(
      (a, b) =>
        byCode(
          String((a as { fontFamily?: unknown }).fontFamily),
          String((b as { fontFamily?: unknown }).fontFamily),
        ) || byCode(JSON.stringify(a), JSON.stringify(b)),
    )
  const parts = [
    `"format": ${JSON.stringify(doc.format)}`,
    `"kind": ${JSON.stringify(doc.kind)}`,
    `"source": ${json(sourceJson(doc.source, `${S}source`), '  ')}`,
    `"tool": ${json(sorted(doc.tool, `${S}tool`), '  ')}`,
    `"params": ${json(sorted(doc.params, `${S}params`), '  ')}`,
    `"frame": ${JSON.stringify(ordered(doc.frame, ['width', 'height', 'pixelRatio'], `${S}frame`))}`,
    `"scroll": ${JSON.stringify({ x: round(doc.scroll.x, BOX_DIGITS), y: round(doc.scroll.y, BOX_DIGITS) })}`,
    `"screenshot": ${JSON.stringify(ordered(doc.screenshot, ['path', 'width', 'height', 'sha256'], `${S}screenshot`))}`,
    lines('elements', elements),
    lines('texts', texts),
    lines('fontFaces', faces),
    `"limits": ${json(
      doc.limits.map((l, i) => ordered(l, ['where', 'reason', 'from', 'to'], `${S}limits[${i}]`)),
      '  ',
    )}`,
  ]
  return `{\n  ${parts.join(',\n  ')}\n}\n`
}
