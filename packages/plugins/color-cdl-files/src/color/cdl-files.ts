// ASC CDL files (.cc, .ccc and .cdl XML) read into plain numbers and written back: slope, offset,
// power and saturation per correction, as color-primary's cdl takes them. Not an XML parser: a
// scan for the few elements the format has, tolerant of what grading tools write (a namespace or
// prefix, a declaration, comments, CRLF, a BOM, numbers over several lines).

type Rgb = readonly [number, number, number]

/** One ASC CDL correction, as a file states it. */
export type Cdl = {
  /** The ColorCorrection's id attribute, when it has one. */
  readonly id?: string
  /** The ColorCorrection's own Description, when it has one (not those inside its nodes). */
  readonly description?: string
  readonly slope: Rgb
  readonly offset: Rgb
  readonly power: Rgb
  readonly saturation: number
}

/** `cc`: one ColorCorrection; `ccc`: a ColorCorrectionCollection; `cdl`: a ColorDecisionList. */
export type CdlForm = 'cc' | 'ccc' | 'cdl'

const NAMESPACE = 'urn:ASC:CDL:v1.2'
const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/
// An element's name with any namespace prefix, and only that name (not ColorCorrectionRef).
const tag = (name: string) => `<(?:[\\w.-]+:)?${name}(?=[\\s/>])`
const close = (name: string) => `</(?:[\\w.-]+:)?${name}\\s*>`

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const fromXml = (s: string) =>
  s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === '#'
      ? String.fromCodePoint(Number(e[1]?.toLowerCase() === 'x' ? `0${e.slice(1)}` : e.slice(1)))
      : (ENTITIES[e] ?? m),
  )
const toXml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

/** The text of the first `name` element in `body`; undefined when there is none. */
const text = (body: string, name: string, where: string) => {
  const open = new RegExp(`${tag(name)}[^>]*>`).exec(body)
  if (!open) return undefined
  const rest = body.slice(open.index + open[0].length)
  const end = new RegExp(close(name)).exec(rest)
  if (!end || rest.slice(0, end.index).includes('<'))
    throw new Error(`.cdl: ${where}: ${name} is not closed`)
  return rest.slice(0, end.index)
}

const numbers = (body: string, name: string, n: number, where: string) => {
  const s = text(body, name, where)
  if (s === undefined) return undefined
  const words = s.trim().split(/\s+/).filter(Boolean)
  if (words.length !== n || !words.every((w) => NUMBER.test(w)))
    throw new Error(
      `.cdl: ${where}: ${name} needs ${n} number${n > 1 ? 's' : ''}, not "${words.join(' ')}"`,
    )
  return words.map(Number)
}

/**
 * A .cc, .ccc or .cdl file's text to its corrections, in the file's order. A missing SOPNode
 * (or Slope, Offset, Power) or SatNode is identity. Throws on a file that is not one, saying what
 * is wrong.
 */
export const readCdl = (file: string): Cdl[] => {
  const xml = file.replace(/^﻿/, '').replace(/<!--[\s\S]*?-->/g, '')
  const out: Cdl[] = []
  const open = new RegExp(`${tag('ColorCorrection')}([^>]*?)(/?)>`, 'g')
  for (let m = open.exec(xml); m; m = open.exec(xml)) {
    const [, attrs = '', selfClosed] = m
    let body = ''
    if (!selfClosed) {
      const end = new RegExp(close('ColorCorrection'), 'g')
      end.lastIndex = open.lastIndex
      const e = end.exec(xml)
      if (!e) throw new Error(`.cdl: ColorCorrection ${out.length + 1} is not closed`)
      body = xml.slice(open.lastIndex, e.index)
      open.lastIndex = end.lastIndex
    }
    const idMatch = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs)
    const id = idMatch ? fromXml(idMatch[1] ?? idMatch[2] ?? '') : undefined
    const where = id === undefined ? `ColorCorrection ${out.length + 1}` : `ColorCorrection "${id}"`
    // The correction's own Description, not one inside its SOPNode or SatNode.
    const own = body.replace(
      new RegExp(`${tag('(SOPNode|SatNode|SATNode)')}[\\s\\S]*?${close('\\1')}`, 'g'),
      '',
    )
    const description = text(own, 'Description', where)
    out.push({
      ...(id === undefined ? {} : { id }),
      ...(description === undefined ? {} : { description: fromXml(description.trim()) }),
      slope: (numbers(body, 'Slope', 3, where) ?? [1, 1, 1]) as unknown as Rgb,
      offset: (numbers(body, 'Offset', 3, where) ?? [0, 0, 0]) as unknown as Rgb,
      power: (numbers(body, 'Power', 3, where) ?? [1, 1, 1]) as unknown as Rgb,
      saturation: numbers(body, 'Saturation', 1, where)?.[0] ?? 1,
    })
  }
  if (out.length === 0) throw new Error('.cdl: no ColorCorrection found')
  return out
}

/**
 * Corrections to the text of a .cc (exactly one), .ccc or .cdl file, ASC CDL v1.2, every number as
 * JavaScript writes it, so reading it back gives the same corrections.
 */
export const writeCdl = (corrections: readonly Cdl[], form: CdlForm): string => {
  if (corrections.length === 0) throw new Error('writeCdl: no corrections')
  if (form === 'cc' && corrections.length !== 1)
    throw new Error(`writeCdl: a .cc file holds one correction, not ${corrections.length}`)
  const indent = { cc: '', ccc: '  ', cdl: '    ' }[form]
  const ns = form === 'cc' ? ` xmlns="${NAMESPACE}"` : ''
  const one = (c: Cdl) => {
    for (const [name, v] of Object.entries({
      slope: c.slope,
      offset: c.offset,
      power: c.power,
      saturation: [c.saturation],
    }))
      if (!v.every(Number.isFinite)) throw new Error(`writeCdl: ${name} must be finite numbers`)
    const lines = [
      `<ColorCorrection${ns}${c.id === undefined ? '' : ` id="${toXml(c.id)}"`}>`,
      ...(c.description === undefined
        ? []
        : [`  <Description>${toXml(c.description)}</Description>`]),
      '  <SOPNode>',
      `    <Slope>${c.slope.join(' ')}</Slope>`,
      `    <Offset>${c.offset.join(' ')}</Offset>`,
      `    <Power>${c.power.join(' ')}</Power>`,
      '  </SOPNode>',
      '  <SatNode>',
      `    <Saturation>${c.saturation}</Saturation>`,
      '  </SatNode>',
      '</ColorCorrection>',
    ]
    return lines.map((l) => indent + l).join('\n')
  }
  const body =
    form === 'cc'
      ? [one(corrections[0] as Cdl)]
      : form === 'ccc'
        ? [
            `<ColorCorrectionCollection xmlns="${NAMESPACE}">`,
            ...corrections.map(one),
            '</ColorCorrectionCollection>',
          ]
        : [
            `<ColorDecisionList xmlns="${NAMESPACE}">`,
            ...corrections.map((c) => `  <ColorDecision>\n${one(c)}\n  </ColorDecision>`),
            '</ColorDecisionList>',
          ]
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body.join('\n')}\n`
}
