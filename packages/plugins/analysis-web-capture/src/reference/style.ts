// The style facts of a reference at one moment, read as frozen analysis data
// (shaderera.analysis/1, kind "reference-style"): each element's box and a set of its computed
// styles (the default list plus any --style), each run of text's line boxes and the fonts it was
// drawn with, the web fonts the page loaded (named, never copied) and a screenshot beside the
// file. tools/capture-web.ts --still writes it; a film reads it here. Nothing here picks a value:
// the film reads what Chrome drew and decides in its own code what to copy.

import { type Host, sha256 } from '@shaderera/core'
import { isFileSource, type Limit, type PageSource, sourceProblem } from './tracks.ts'

/** A box in CSS pixels, from the viewport's top left: x, y, width, height. */
export type Box = [x: number, y: number, width: number, height: number]

/** One element (or one of its pseudo-elements) Chrome laid out. */
export type StyledElement = {
  /** A CSS selector for it: `[data-id="…"]` or `#id` when unique, else its path from the root. */
  element: string
  /** Its `data-id`, when it has one. */
  dataId?: string
  /** Its tag, as `localName` gives it. */
  tag: string
  /** `::before`, `::after`, `::marker`…, when the entry is that pseudo-element of `element`. */
  pseudoElement?: string
  /** The box as drawn, after transforms. */
  box: Box
  /** Chrome's paint order: a higher one is drawn later, over a lower one. */
  paintOrder: number
  /** Each style in params.styles, as Chrome computed it, in that order. */
  styles: Record<string, string>
  /** Fields a later capture adds, kept as written. */
  [key: string]: unknown
}

/** A font Chrome drew some of a text node's glyphs with. */
export type DrawnFont = {
  familyName: string
  postScriptName: string
  /** Downloaded or resolved by the page (a web font), not a system font Chrome fell back to. */
  isCustomFont: boolean
  glyphCount: number
}

/** One text node, as Chrome laid it out. */
export type TextRun = {
  /** The element that holds it, named as in `elements`. */
  element: string
  pseudoElement?: string
  /** Its index in the element's child nodes (pseudo-elements not counted). */
  child: number
  /** The text as laid out: white space collapsed and text-transform applied. */
  text: string
  /** One per line fragment: its box, and the UTF-16 range of `text` it holds. */
  boxes: { box: Box; start: number; length: number }[]
  fonts: DrawnFont[]
  [key: string]: unknown
}

/** What a reference-style artifact holds, and the path it was read from. */
export type ReferenceStyle = {
  format: 'shaderera.analysis/1'
  kind: 'reference-style'
  source: { path: string; bytes: number; sha256: string } | PageSource
  tool: Record<string, unknown>
  /** Every setting that changed the output (still, rafHz, seed, root, styles, trigger…). */
  params: Record<string, unknown>
  /** The viewport in CSS pixels, and device pixels per CSS pixel. */
  frame: { width: number; height: number; pixelRatio: number }
  /** The window's scroll at the moment, in CSS pixels. */
  scroll: { x: number; y: number }
  /** The page as drawn, a PNG beside the artifact, at the viewport in device pixels. */
  screenshot: { path: string; width: number; height: number; sha256: string }
  elements: StyledElement[]
  texts: TextRun[]
  /** Each web font the page loaded, as Chrome reports it; a `data:` src is its media type only. */
  fontFaces: Record<string, unknown>[]
  limits: Limit[]
  path: string
}

const KIND = 'reference-style'
const HEX = /^[0-9a-f]{64}$/
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isSize = (v: unknown) => isNumber(v) && v > 0
const isCount = (v: unknown) => Number.isInteger(v) && (v as number) >= 0
const isBox = (v: unknown) =>
  Array.isArray(v) && v.length === 4 && v.every(isNumber) && v.slice(2).every((n) => n >= 0)

/**
 * What is wrong with a parsed artifact, as one message naming the first problem, or nothing. Used
 * by `loadStyle` and by the writer in tools/reference-style.ts. Fields it does not know are kept.
 */
export const styleProblem = (doc: unknown, name: string): string | undefined => {
  if (!isObject(doc)) return `${name} is not a JSON object`
  if (doc.format !== 'shaderera.analysis/1')
    return `${name} is ${JSON.stringify(doc.format)}, not shaderera.analysis/1; rebuild it with its analyser`
  if (doc.kind !== KIND)
    return `${name} is a ${JSON.stringify(doc.kind)} analysis, not ${KIND}${
      doc.kind === 'reference-tracks' ? ': read it with loadTracks' : ''
    }`
  const source = sourceProblem(doc.source, name)
  if (source) return source
  if (!isObject(doc.tool)) return `${name} has no tool`
  if (!isObject(doc.params)) return `${name} has no params`
  const f = doc.frame
  if (!isObject(f) || !isSize(f.width) || !isSize(f.height) || !isSize(f.pixelRatio))
    return `${name} needs frame { width, height, pixelRatio }, each above 0`
  const s = doc.scroll
  if (!isObject(s) || !isNumber(s.x) || !isNumber(s.y)) return `${name} needs scroll { x, y }`
  const p = doc.screenshot
  if (
    !isObject(p) ||
    !isText(p.path) ||
    !isSize(p.width) ||
    !isSize(p.height) ||
    typeof p.sha256 !== 'string' ||
    !HEX.test(p.sha256)
  )
    return `${name} needs screenshot { path, width, height, sha256 }`
  if (p.path.includes('/') || p.path.includes('\\'))
    return `${name}'s screenshot ${p.path} is not a file beside it`
  if (!Array.isArray(doc.elements)) return `${name} has no elements`
  for (const [i, e] of doc.elements.entries()) {
    if (!isObject(e) || !isText(e.element) || !isText(e.tag))
      return `${name}'s element ${i} needs an element and a tag`
    const label = `${name}'s element ${i} (${e.element}${e.pseudoElement ?? ''})`
    if (!isBox(e.box)) return `${label} needs a box [x, y, width, height]`
    if (!isCount(e.paintOrder)) return `${label} needs a paintOrder`
    if (!isObject(e.styles) || !Object.values(e.styles).every((v) => typeof v === 'string'))
      return `${label}'s styles are not names to computed values`
  }
  if (!Array.isArray(doc.texts)) return `${name} has no texts`
  for (const [i, t] of doc.texts.entries()) {
    if (!isObject(t) || !isText(t.element) || !isCount(t.child) || typeof t.text !== 'string')
      return `${name}'s text ${i} needs an element, a child and its text`
    const label = `${name}'s text ${i} (${t.element} child ${t.child})`
    if (
      !Array.isArray(t.boxes) ||
      !t.boxes.every((b) => isObject(b) && isBox(b.box) && isCount(b.start) && isCount(b.length))
    )
      return `${label}'s boxes need a box, a start and a length each`
    if (
      !Array.isArray(t.fonts) ||
      !t.fonts.every(
        (g) =>
          isObject(g) &&
          typeof g.familyName === 'string' &&
          typeof g.postScriptName === 'string' &&
          typeof g.isCustomFont === 'boolean' &&
          isCount(g.glyphCount),
      )
    )
      return `${label}'s fonts need a familyName, postScriptName, isCustomFont and glyphCount each`
  }
  if (!Array.isArray(doc.fontFaces) || !doc.fontFaces.every(isObject))
    return `${name}'s fontFaces need to be a list of objects`
  if (!Array.isArray(doc.limits)) return `${name}'s limits need to be a list`
  for (const [i, l] of doc.limits.entries())
    if (!isObject(l) || !isText(l.where) || !isText(l.reason))
      return `${name}'s limit ${i} needs a where and a reason`
  return undefined
}

/**
 * Reads a reference-style artifact. Refuses another format or kind, a malformed one, a screenshot
 * whose bytes are not the ones captured, and a source file that changed.
 */
export const loadStyle = async (host: Host, path: string): Promise<ReferenceStyle> => {
  const text = new TextDecoder().decode(await host.io.read(path))
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (e) {
    throw new Error(`${path} is not JSON (${(e as Error).message}); rebuild it with its analyser`)
  }
  const wrong = styleProblem(doc, path)
  if (wrong) throw new Error(wrong)
  const style = doc as Omit<ReferenceStyle, 'path'>
  const beside = `${path.slice(0, path.lastIndexOf('/') + 1)}${style.screenshot.path}`
  if ((await sha256(await host.io.read(beside))) !== style.screenshot.sha256)
    throw new Error(`${beside} is not the screenshot ${path} was captured with; capture it again`)
  if (isFileSource(style.source)) {
    const { path: file, sha256: expected } = style.source
    if ((await sha256(await host.io.read(file))) !== expected)
      throw new Error(`${path} was measured from other bytes than ${file}; run its analyser again`)
  }
  return { ...style, path }
}

/** One element's entry (or its pseudo-element's). Refuses a missing one, naming what there is. */
export const styleOf = (
  style: ReferenceStyle,
  element: string,
  pseudoElement?: string,
): StyledElement => {
  const found = style.elements.find(
    (e) => e.element === element && e.pseudoElement === pseudoElement,
  )
  if (found) return found
  const names = style.elements.map((e) => e.element + (e.pseudoElement ?? ''))
  throw new Error(
    `${style.path} has no element ${element}${pseudoElement ?? ''}: it has ${names.join(', ') || 'none'}`,
  )
}

/** The text nodes an element holds, in document order; none is an empty list. */
export const textsOf = (style: ReferenceStyle, element: string, pseudoElement?: string) =>
  style.texts.filter((t) => t.element === element && t.pseudoElement === pseudoElement)
