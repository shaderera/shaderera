import type { MountDom } from '@shaderera/core'

/**
 * A DOM per `mode`: `still` (settles at every t), `clock` (moves on its own timer), `image` (an
 * image that does not exist) and `font` (a font face that fails to load).
 */
const mount: MountDom = (element, { params }) => {
  const mode = params.mode
  element.style.cssText += ';background:#fff;font:16px sans-serif'
  const text = document.createElement('div')
  element.append(text)
  let timer: ReturnType<typeof setInterval> | undefined
  if (mode === 'clock') timer = setInterval(() => (text.textContent = String(performance.now())), 5)
  if (mode === 'image') {
    const img = document.createElement('img')
    img.src = '/missing.png'
    element.append(img)
  }
  if (mode === 'type') {
    // A web font with Latin only: Thai in it is drawn by a system fallback.
    const latin = new URL('./fonts/NotoSans-Regular.ttf', import.meta.url)
    document.fonts.add(new FontFace('Latin', `url(${latin.href})`))
    element.innerHTML =
      '<div data-id="latin" style="font:20px Latin">Open</div>' +
      '<div data-id="mixed" style="font:20px Latin;opacity:0.5">Open เปิด</div>'
  }
  if (mode === 'font') {
    const face = new FontFace('Broken', 'url(/missing.woff2)')
    document.fonts.add(face)
    face.load().catch(() => {})
    text.style.fontFamily = 'Broken'
  }
  return {
    seek: (t) => {
      if (mode !== 'clock') text.textContent = `t=${t.toFixed(1)}`
    },
    dispose: () => clearInterval(timer),
  }
}
export default mount
