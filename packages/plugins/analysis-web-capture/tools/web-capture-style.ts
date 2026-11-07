// The style facts of a page at one moment, read over the DevTools protocol for capture-web.ts
// --still: one DOMSnapshot.captureSnapshot for every element's box, paint order and computed
// styles and every text node's line boxes, CSS.getPlatformFontsForNode for the fonts each text
// node was drawn with, CSS.fontsUpdated for the web fonts the page loaded, and
// Page.captureScreenshot for the picture. DOMSnapshot and CSS are experimental domains, so the
// capture records Chrome's version, and a field Chrome no longer sends fails here with its name.

import type { Box, DrawnFont, StyledElement, TextRun } from '../src/reference/style.ts'
import type { Limit } from '../src/reference/tracks.ts'

/**
 * The computed styles read for every element by default, as CSS names them: the ones that change
 * how text, a box and its edges, its background, an image or an SVG shape are drawn. `--style`
 * adds to them; none is left out. Where an element is and how big it is are its box.
 */
export const STYLES = [
  'font-family',
  'font-weight',
  'font-style',
  'font-stretch',
  'font-size',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'font-feature-settings',
  'font-variation-settings',
  'text-transform',
  'text-align',
  'text-decoration-line',
  'text-decoration-style',
  'text-decoration-color',
  'text-decoration-thickness',
  'text-underline-offset',
  'color',
  'background-color',
  'background-image',
  'background-position',
  'background-size',
  'background-repeat',
  'background-clip',
  ...['top', 'right', 'bottom', 'left'].flatMap((side) =>
    ['width', 'style', 'color'].map((what) => `border-${side}-${what}`),
  ),
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
  'outline-width',
  'outline-style',
  'outline-color',
  'outline-offset',
  'box-shadow',
  'text-shadow',
  'transform',
  'translate',
  'rotate',
  'scale',
  'transform-origin',
  'opacity',
  'visibility',
  'filter',
  'backdrop-filter',
  'mix-blend-mode',
  'clip-path',
  'mask-image',
  'object-fit',
  'object-position',
  'fill',
  'stroke',
  'stroke-width',
]

/** Elements whose drawing is pixels only: no box or style inside them says what they show. */
const PIXELS: Record<string, string> = {
  canvas: 'a canvas: what it draws is only in the screenshot',
  video: 'a video: what it shows is only in the screenshot',
  iframe: 'an iframe: its document is not read, only drawn in the screenshot',
  embed: 'an embed: what it shows is only in the screenshot',
  object: 'an object: what it shows is only in the screenshot',
  input: "an input: its text is drawn by the browser's own control, only in the screenshot",
  textarea: "a textarea: its text is drawn by the browser's own control, only in the screenshot",
  select: "a select: its text is drawn by the browser's own control, only in the screenshot",
}

/** A command on the page's session. */
export type Send = <T = Record<string, unknown>>(
  method: string,
  params?: Record<string, unknown>,
) => Promise<T>

type Snapshot = {
  documents: {
    nodes: {
      parentIndex: number[]
      nodeType: number[]
      nodeName: number[]
      nodeValue: number[]
      backendNodeId: number[]
      attributes: number[][]
      pseudoType?: { index: number[]; value: number[] }
    }
    layout: {
      nodeIndex: number[]
      styles: number[][]
      bounds: number[][]
      text: number[]
      paintOrders?: number[]
    }
    textBoxes: { layoutIndex: number[]; bounds: number[][]; start: number[]; length: number[] }
    scrollOffsetX?: number
    scrollOffsetY?: number
  }[]
  strings: string[]
}

// Run in the page on the nodes the snapshot laid out: an element's name, a selector that finds
// it; a text node's [its parent's name, its index in the parent's childNodes]. The name is
// `[data-id="…"]` or `#id` when that is unique in its tree, else the path from the root of its
// tree, `tag:nth-child(n)` where the parent has more than one element child. An element in a
// shadow tree is named after its host and ` >>> `, as the snapshot flattens shadow roots.
const NAMES = `function (...nodes) {
  const names = new Map()
  const segment = (el) => {
    const p = el.parentNode
    const siblings = p ? [...p.children] : []
    return siblings.length > 1 ? el.localName + ':nth-child(' + (siblings.indexOf(el) + 1) + ')' : el.localName
  }
  const name = (el) => {
    if (names.has(el)) return names.get(el)
    const scope = el.getRootNode()
    const prefix = scope instanceof ShadowRoot ? name(scope.host) + ' >>> ' : ''
    const unique = (sel) => scope.querySelectorAll(sel).length === 1
    const dataId = el.getAttribute('data-id')
    const byData = dataId === null ? null : '[data-id="' + CSS.escape(dataId) + '"]'
    const byId = el.id ? '#' + CSS.escape(el.id) : null
    const p = el.parentNode
    const n = byData && unique(byData) ? prefix + byData
      : byId && unique(byId) ? prefix + byId
      : p instanceof Element ? name(p) + ' > ' + segment(el)
      : prefix + segment(el)
    names.set(el, n)
    return n
  }
  return nodes.map((n) => {
    if (n instanceof Element) return name(n)
    const p = n && n.parentNode
    if (!p) return null
    return [name(p instanceof ShadowRoot ? p.host : p), [...p.childNodes].indexOf(n)]
  })
}`

const need = <T>(v: T | undefined, what: string): T => {
  if (v === undefined)
    throw new Error(
      `Chrome sent no ${what}: this Chrome's DevTools protocol differs from the one the capture reads; give its version in an issue`,
    )
  return v
}

/** The screenshot's width and height in pixels, from its PNG header. */
export const pngSize = (png: Uint8Array) => {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  if (png.length < 24 || view.getUint32(12) !== 0x49484452)
    throw new Error('Chrome sent a screenshot that is not a PNG')
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/**
 * Reads the page's style facts under `root` (the first match) as they are now. `fontFaces` are
 * the CSS.fontsUpdated faces seen so far. Refuses a root that matches nothing.
 */
export const readStyle = async (
  send: Send,
  {
    root,
    styles,
    fontFaces,
  }: { root: string; styles: string[]; fontFaces: Record<string, unknown>[] },
) => {
  const limits: Limit[] = []
  const { root: document } = await send<{ root: { nodeId: number } }>('DOM.getDocument', {
    depth: 0,
  })
  const { nodeIds } = await send<{ nodeIds: number[] }>('DOM.querySelectorAll', {
    nodeId: document.nodeId,
    selector: root,
  })
  const first = nodeIds[0]
  if (first === undefined)
    throw new Error(`--root ${JSON.stringify(root)} matches nothing at the still`)
  if (nodeIds.length > 1)
    limits.push({
      where: root,
      reason: `${nodeIds.length} elements match it: the first in document order is read`,
    })
  const { node } = await send<{ node: { backendNodeId: number } }>('DOM.describeNode', {
    nodeId: first,
  })

  const snap = await send<Snapshot>('DOMSnapshot.captureSnapshot', {
    computedStyles: styles,
    includePaintOrder: true,
  })
  const str = (i: number | undefined) =>
    i === undefined || i < 0 ? undefined : need(snap.strings[i], `string ${i} of the snapshot`)
  const d = need(snap.documents[0], 'document in the snapshot')
  const nodes = d.nodes
  const layout = d.layout
  need(nodes.parentIndex, 'nodes.parentIndex')
  need(nodes.backendNodeId, 'nodes.backendNodeId')
  need(layout.paintOrders, 'layout.paintOrders')
  need(d.textBoxes, 'textBoxes')
  const sx = need(d.scrollOffsetX, 'scrollOffsetX')
  const sy = need(d.scrollOffsetY, 'scrollOffsetY')
  const at = (b: number[] | undefined, what: string): Box => {
    const [x, y, w, h] = need(b, what)
    return [(x as number) - sx, (y as number) - sy, w as number, h as number]
  }

  const pseudo = new Map<number, string>()
  nodes.pseudoType?.index.forEach((n, i) => {
    pseudo.set(n, `::${str(nodes.pseudoType?.value[i])}`)
  })
  const attr = (i: number, name: string) => {
    const a = nodes.attributes[i] ?? []
    for (let k = 0; k < a.length; k += 2) if (str(a[k]) === name) return str(a[k + 1]) ?? ''
    return undefined
  }
  const isElement = (i: number) => nodes.nodeType[i] === 1 && !pseudo.has(i)
  const tagOf = (i: number) => {
    const n = str(nodes.nodeName[i]) as string
    return n === n.toUpperCase() ? n.toLowerCase() : n
  }
  // Whether a node is the root or under it (a shadow tree's nodes are under their host).
  const rootIndex = nodes.backendNodeId.indexOf(node.backendNodeId)
  if (rootIndex < 0) throw new Error(`--root ${JSON.stringify(root)} is not in the snapshot`)
  const under = (i: number) => {
    for (let n = i; n >= 0; n = nodes.parentIndex[n] as number) if (n === rootIndex) return true
    return false
  }
  /** The element a node belongs to, and its pseudo-element when it is in one. */
  const owner = (i: number) => {
    let n = i
    let pseudoElement: string | undefined
    while (n >= 0 && !isElement(n)) {
      pseudoElement ??= pseudo.get(n)
      n = nodes.parentIndex[n] as number
    }
    return { element: n, pseudoElement }
  }

  // Each node's first layout object, in document order (the order the snapshot lists nodes in).
  const layoutOf = new Map<number, number>()
  layout.nodeIndex.forEach((n, li) => {
    if (!layoutOf.has(n)) layoutOf.set(n, li)
  })
  const laidOut = [...layoutOf].sort(([a], [b]) => a - b).filter(([n]) => under(n))
  const boxed = laidOut.filter(([n]) => nodes.nodeType[n] === 1)
  // Text as laid out: each text node, and each run of a pseudo-element's generated content (a
  // layout object of the pseudo-element itself, with text), in document order.
  const textNodes = layout.nodeIndex
    .map((n, li) => [n, li] as const)
    .filter(
      ([n, li]) =>
        under(n) && (nodes.nodeType[n] === 3 || (pseudo.has(n) && (layout.text[li] ?? -1) >= 0)),
    )
    .sort(([a, i], [b, j]) => a - b || i - j)

  // Names from the page itself: the elements drawn (a pseudo-element's own) and the text nodes.
  const asked = [
    ...new Set([...boxed.map(([n]) => owner(n).element), ...textNodes.map(([n]) => n)]),
  ]
  const group = 'shaderera-style'
  const objects = await Promise.all(
    asked.map((n) =>
      send<{ object: { objectId?: string } }>('DOM.resolveNode', {
        backendNodeId: nodes.backendNodeId[n],
        objectGroup: group,
      })
        .then((r) => r.object.objectId)
        .catch(() => undefined),
    ),
  )
  const named = new Map<number, string | [string, number] | null>()
  const resolved = asked.flatMap((n, k) => (objects[k] ? [[n, objects[k]] as const] : []))
  if (resolved.length > 0) {
    const r = await send<{
      result: { value?: (string | [string, number] | null)[] }
      exceptionDetails?: { text: string }
    }>('Runtime.callFunctionOn', {
      functionDeclaration: NAMES,
      objectId: resolved[0]?.[1],
      arguments: resolved.map(([, objectId]) => ({ objectId })),
      returnByValue: true,
    })
    if (r.exceptionDetails)
      throw new Error(`naming the elements failed: ${r.exceptionDetails.text}`)
    const values = need(r.result.value, 'names from the page')
    resolved.forEach(([n], k) => {
      named.set(n, values[k] ?? null)
    })
  }
  await send('Runtime.releaseObjectGroup', { objectGroup: group })
  const nameOf = (n: number) => {
    const v = named.get(n)
    if (typeof v !== 'string')
      throw new Error(`the page could not name its ${tagOf(n)} element (node ${n} of the snapshot)`)
    return v
  }

  const elements: StyledElement[] = []
  const paint = layout.paintOrders as number[]
  for (const [n, li] of boxed) {
    const { element, pseudoElement } = owner(n)
    const values = need(layout.styles[li], `styles of layout node ${li}`)
    const entry: StyledElement = {
      element: nameOf(element),
      tag: tagOf(element),
      box: at(layout.bounds[li], `bounds of layout node ${li}`),
      paintOrder: need(paint[li], `paint order of layout node ${li}`),
      styles: Object.fromEntries(styles.map((s, k) => [s, str(values[k]) ?? ''])),
    }
    const dataId = attr(element, 'data-id')
    if (dataId !== undefined) entry.dataId = dataId
    if (pseudoElement) entry.pseudoElement = pseudoElement
    elements.push(entry)
    const why = pseudoElement ? undefined : PIXELS[entry.tag]
    if (why) limits.push({ where: entry.element, reason: why })
  }

  // Each laid-out text node under the root, with its line boxes.
  const boxesOf = new Map<number, TextRun['boxes']>()
  d.textBoxes.layoutIndex.forEach((li, k) => {
    const list = boxesOf.get(li) ?? []
    list.push({
      box: at(d.textBoxes.bounds[k], `bounds of text box ${k}`),
      start: need(d.textBoxes.start[k], `start of text box ${k}`),
      length: need(d.textBoxes.length[k], `length of text box ${k}`),
    })
    boxesOf.set(li, list)
  })
  const { nodeIds: textIds } = await send<{ nodeIds: number[] }>(
    'DOM.pushNodesByBackendIdsToFrontend',
    { backendNodeIds: textNodes.map(([n]) => nodes.backendNodeId[n]) },
  )
  const texts: TextRun[] = []
  for (const [k, [n, li]] of textNodes.entries()) {
    // White space between elements is laid out with no line box: nothing of it is drawn.
    if (!boxesOf.has(li)) continue
    const { element, pseudoElement } = owner(n)
    // A pseudo-element's generated text is no DOM node: its runs are counted in their order.
    const here = named.get(n)
    const [holder, child] = Array.isArray(here)
      ? here
      : [nameOf(element), textNodes.slice(0, k).filter(([m]) => m === n).length]
    const run: TextRun = {
      element: holder,
      child,
      text: str(layout.text[li]) ?? str(nodes.nodeValue[n]) ?? '',
      boxes: boxesOf.get(li) ?? [],
      fonts: [],
    }
    if (pseudoElement) run.pseudoElement = pseudoElement
    const nodeId = textIds[k]
    if (nodeId) {
      const { fonts } = await send<{ fonts: DrawnFont[] }>('CSS.getPlatformFontsForNode', {
        nodeId,
      })
      run.fonts = need(fonts, 'fonts from CSS.getPlatformFontsForNode').map((f) => ({
        familyName: need(f.familyName, 'a font familyName'),
        postScriptName: need(f.postScriptName, 'a font postScriptName'),
        isCustomFont: need(f.isCustomFont, 'a font isCustomFont'),
        glyphCount: need(f.glyphCount, 'a font glyphCount'),
      }))
    } else
      limits.push({
        where: run.element,
        reason: `its text node ${run.child} has no node to ask for fonts`,
      })
    texts.push(run)
  }

  // A font inline in the page is its media type only: its bytes are the font file. A blob: URL
  // is its origin only: the rest is new on each load. Faces are sorted, as they load in any order.
  const faces = [
    ...new Map(
      fontFaces.map((f) => {
        const src = typeof f.src === 'string' ? f.src : undefined
        const face = src?.startsWith('data:')
          ? { ...f, src: src.slice(0, src.search(/[,;]|$/)) }
          : src?.startsWith('blob:')
            ? { ...f, src: src.slice(0, Math.max(5, src.lastIndexOf('/'))) }
            : f
        return [JSON.stringify(face), face] as const
      }),
    ),
  ]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, face]) => face)

  const png = await screenshot(send)
  return { elements, texts, fontFaces: faces, scroll: { x: sx, y: sy }, png, limits }
}

/** The viewport as it is drawn now, a PNG. */
export const screenshot = async (send: Send) => {
  const { data } = await send<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  })
  return new Uint8Array(Buffer.from(need(data, 'screenshot data'), 'base64'))
}
