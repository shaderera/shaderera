// The project's DOM (manifest.dom) on the runner page: laid out inside a canvas and drawn into it
// with HTML-in-Canvas (drawElementImage; Chrome behind --enable-features=CanvasDrawElement), at the
// t the worker asks for. Canvases inside the DOM (WebGL, WebGPU) are drawn by hand where they are
// on the page, under the snapshot, which does not carry them where they are.
import type { DomView, Json, Manifest, MountDom } from '@shaderera/core'

type DrawingCanvas = HTMLCanvasElement & { requestPaint(): void }
type DrawingContext = CanvasRenderingContext2D & {
  drawElementImage(element: Element, x: number, y: number): void
}

const frame = () => new Promise((r) => requestAnimationFrame(r))
/** Snapshots after the first that may still differ before a capture fails as unsettled. */
const SETTLE = 6

/** The canvas's next paint, or a few frames when the page sends none (its snapshot is still new). */
const painted = (canvas: DrawingCanvas) =>
  Promise.race([
    new Promise<void>((resolve) => {
      canvas.addEventListener('paint', () => resolve(), { once: true })
      canvas.requestPaint()
    }),
    (async () => {
      for (let i = 0; i < 3; i++) await frame()
    })(),
  ])

const mount = async (
  manifest: Manifest,
  params: { [key: string]: Json },
  /** A saved revision's DOM module; the live project's otherwise. */
  module?: string,
) => {
  const canvas = document.createElement('canvas') as DrawingCanvas
  // domScale: the DOM keeps its layout at the frame's size and is drawn with more pixels.
  const scale = manifest.domScale ?? 1
  canvas.width = manifest.width * scale
  canvas.height = manifest.height * scale
  canvas.setAttribute('layoutsubtree', '')
  canvas.setAttribute('content', 'drawable')
  canvas.style.cssText = `position:absolute;left:0;top:0;width:${manifest.width}px;height:${manifest.height}px`
  const element = document.createElement('div')
  element.setAttribute('drawable', '')
  element.style.cssText = `width:${manifest.width}px;height:${manifest.height}px`
  canvas.append(element)
  document.body.append(canvas)
  const style = document.createElement('style')
  style.textContent = '[data-shaderera-dom] canvas { opacity: 0; }'
  element.dataset.shadereraDom = ''
  document.head.append(style)
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as DrawingContext
  if (typeof ctx.drawElementImage !== 'function')
    throw new Error(
      'This browser cannot draw the DOM (HTML-in-Canvas): run Chrome with --enable-features=CanvasDrawElement.',
    )
  const loaded = (
    module
      ? await import(/* @vite-ignore */ module)
      : // @ts-expect-error: served by the runner plugin, which re-exports manifest.dom.
        await import('/__shaderera/dom.js')
  ) as { default: MountDom | null }
  if (!loaded.default) throw new Error('manifest.dom has no default export.')
  const view: DomView = await loaded.default(element, { manifest, params })
  await document.fonts.ready
  /** CSS animations and transitions on the page's clock would differ run to run: held at t. */
  const hold = (t: number) => {
    for (const a of element.getAnimations({ subtree: true })) {
      a.pause()
      a.currentTime = t * 1000
    }
  }
  const snapshot = async (t: number) => {
    // Held at t, then the canvas's next paint. No rAF waits for the framework (decision 0007:
    // they cost about 100 ms a frame): one that commits late makes the next snapshot differ, and
    // `draw` takes a frame only when two snapshots in a row agree.
    hold(t)
    await painted(canvas)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    // The inner canvases are placed by hand in CSS pixels; drawElementImage itself already draws
    // at the canvas's own resolution (measured: a transform on it scales twice).
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    const box = canvas.getBoundingClientRect()
    for (const c of element.querySelectorAll('canvas')) {
      const r = c.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) ctx.drawImage(c, r.x - box.x, r.y - box.y, r.width, r.height)
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawElementImage(element, 0, 0)
    return ctx.getImageData(0, 0, canvas.width, canvas.height).data
  }
  /**
   * What t shows must be loaded before it is drawn: every font face the page asked for, every
   * image, and every video at a frame. A missing one fails the capture with its name; it is never
   * drawn as a blank and accepted.
   */
  const ready = async (t: number) => {
    await document.fonts.ready
    const fonts = [...document.fonts].filter((f) => f.status === 'error')
    if (fonts.length > 0)
      throw new Error(
        `The DOM at t=${t} is not ready: font ${fonts.map((f) => `"${f.family}"`).join(', ')} failed to load.`,
      )
    for (const img of element.querySelectorAll('img')) {
      if (!img.complete) await img.decode().catch(() => {})
      if (img.naturalWidth === 0)
        throw new Error(
          `The DOM at t=${t} is not ready: image ${img.currentSrc || img.src} did not load.`,
        )
    }
    for (const video of element.querySelectorAll('video')) {
      for (let i = 0; i < 100 && (video.readyState < 2 || video.seeking); i++) await frame()
      if (video.readyState < 2 || video.seeking)
        throw new Error(
          `The DOM at t=${t} is not ready: video ${video.currentSrc || video.src} has no frame at ${video.currentTime} s (seek it in DomView.seek and await 'seeked').`,
        )
    }
  }
  const same = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
    if (a.length !== b.length) return false
    // A pixel at a time (RGBA is 4 bytes): a quarter of the comparisons.
    const x = new Uint32Array(a.buffer, a.byteOffset, a.length >> 2)
    const y = new Uint32Array(b.buffer, b.byteOffset, b.length >> 2)
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
    return true
  }
  /**
   * The DOM at t, once two snapshots in a row agree: a part that settles a frame late (a canvas
   * redrawn after a layout effect) must not carry the previous t into this one. A DOM that is still
   * changing after SETTLE snapshots (a clock-driven animation, a request still in flight) fails.
   */
  const draw = async (t: number) => {
    await view.seek(t)
    await ready(t)
    let last = await snapshot(t)
    for (let i = 1; ; i++) {
      const next = await snapshot(t)
      if (same(last, next)) break
      if (i === SETTLE)
        throw new Error(
          `The DOM at t=${t} did not settle: ${SETTLE + 1} snapshots in a row differed. Something in it moves on its own clock (a timer, requestAnimationFrame, a video playing) or is still loading.`,
        )
      last = next
    }
    return createImageBitmap(canvas)
  }
  /**
   * The DOM's text as laid out at t, measured by the page, not reported by the participant: each
   * element's own text, its font, size and effective opacity, and its box in frame pixels.
   */
  const text = async (t: number) => {
    ;(await draw(t)).close()
    // Each measured element is marked, so the host can ask Chrome which fonts drew it.
    for (const e of element.querySelectorAll('[data-shaderera-run]'))
      e.removeAttribute('data-shaderera-run')
    const origin = element.getBoundingClientRect()
    const own = new Map<Element, { text: string; range: Range[] }>()
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement
      if (!parent || !node.textContent?.trim()) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      const entry = own.get(parent) ?? { text: '', range: [] }
      entry.text += node.textContent
      entry.range.push(range)
      own.set(parent, entry)
    }
    const runs: {
      id: string
      text: string
      font: string
      size: number
      box: number[]
      opacity: number
    }[] = []
    let n = 0
    for (const [el, { text: content, range }] of own) {
      const rects = range
        .map((r) => r.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
      if (rects.length === 0) continue
      const x = Math.min(...rects.map((r) => r.left)) - origin.left
      const y = Math.min(...rects.map((r) => r.top)) - origin.top
      const right = Math.max(...rects.map((r) => r.right)) - origin.left
      const bottom = Math.max(...rects.map((r) => r.bottom)) - origin.top
      let opacity = 1
      for (let e: Element | null = el; e && e !== element.parentElement; e = e.parentElement)
        opacity *= Number(getComputedStyle(e).opacity)
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden') opacity = 0
      el.setAttribute('data-shaderera-run', String(runs.length))
      runs.push({
        id: (el as HTMLElement).dataset.id || el.id || `dom:${el.tagName.toLowerCase()}:${n}`,
        text: content.replace(/\s+/g, ' ').trim(),
        font: style.fontFamily,
        size: Number.parseFloat(style.fontSize),
        box: [x, y, right - x, bottom - y],
        opacity,
      })
      n++
    }
    return runs
  }
  // The page's first drawings differ from later ones at the same t (what the page loads and caches
  // on its way, such as glyphs): the start and the middle are drawn once and thrown away.
  await draw(manifest.duration / 2)
  await draw(0)
  const dispose = () => {
    view.dispose?.()
    canvas.remove()
    style.remove()
  }
  return { draw, text, dispose }
}

/** Answers the worker: `mount` lays the DOM out, `t` draws it at that time. */
export const domHost = (port: MessagePort) => {
  let current: Awaited<ReturnType<typeof mount>> | undefined
  port.onmessage = async (e: MessageEvent) => {
    const m = e.data as {
      id: number
      t?: number
      mount?: { manifest: Manifest; params: { [key: string]: Json }; module?: string }
      text?: number
    }
    try {
      if (m.mount) {
        current?.dispose()
        current = await mount(m.mount.manifest, m.mount.params, m.mount.module)
        // For a host's checks: the DOM drawn at t, as bytes, without a render.
        ;(window as unknown as { __shadereraDom: unknown }).__shadereraDom = async (t: number) => {
          const bitmap = await current?.draw(t)
          const c = new OffscreenCanvas(bitmap!.width, bitmap!.height).getContext('2d')!
          c.drawImage(bitmap!, 0, 0)
          return c.getImageData(0, 0, bitmap!.width, bitmap!.height).data
        }
        port.postMessage({ id: m.id })
      } else if (m.text !== undefined) {
        if (!current) throw new Error('The DOM is not mounted.')
        port.postMessage({ id: m.id, runs: await current.text(m.text) })
      } else if (m.t !== undefined) {
        if (!current) throw new Error('The DOM is not mounted.')
        const bitmap = await current.draw(m.t)
        port.postMessage({ id: m.id, bitmap }, [bitmap])
      }
    } catch (error) {
      port.postMessage({ id: m.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
}
