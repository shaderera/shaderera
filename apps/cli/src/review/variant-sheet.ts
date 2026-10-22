import { createCanvas } from '@napi-rs/canvas'

/** One variant's frames for the sheet: its name, frame size, safe area and a frame per moment. */
export type VariantFrames = {
  name: string
  width: number
  height: number
  /** requirements.json's margins for this output, as fractions of the frame. */
  safeArea?: { top: number; right: number; bottom: number; left: number }
  frames: readonly { t: number; pixels: Uint8Array }[]
}

/** The height every frame is shown at: the tallest frame's, at most this. */
const HEIGHT = 720
const PAD = 8
const LABEL = 22

/**
 * The variants side by side: a row per moment, each variant's frame scaled to the same height and
 * labelled with its name, t and size underneath; the safe area, when the output declares one,
 * drawn over it as a dashed line. Only the sheet is scaled and drawn on: the frames are not.
 */
export const variantSheet = (variants: readonly VariantFrames[]): Promise<Buffer> => {
  const height = Math.min(HEIGHT, Math.max(...variants.map((v) => v.height)))
  const widths = variants.map((v) => Math.max(1, Math.round((v.width * height) / v.height)))
  const times = [...new Set(variants.flatMap((v) => v.frames.map((f) => f.t)))].sort(
    (a, b) => a - b,
  )
  const sheet = createCanvas(
    PAD + widths.reduce((sum, w) => sum + w + PAD, 0),
    PAD + times.length * (height + LABEL + PAD),
  ).getContext('2d')
  sheet.fillStyle = '#16181c'
  sheet.fillRect(0, 0, sheet.canvas.width, sheet.canvas.height)
  let x = PAD
  variants.forEach((v, i) => {
    const w = widths[i] as number
    const full = createCanvas(v.width, v.height).getContext('2d')
    for (const f of v.frames) {
      const y = PAD + times.indexOf(f.t) * (height + LABEL + PAD)
      const image = full.createImageData(v.width, v.height)
      image.data.set(f.pixels)
      full.putImageData(image, 0, 0)
      // Grey under the frame shows transparency.
      sheet.fillStyle = '#3a3d44'
      sheet.fillRect(x, y, w, height)
      sheet.drawImage(full.canvas, x, y, w, height)
      if (v.safeArea) {
        const s = v.safeArea
        sheet.save()
        sheet.strokeStyle = '#38d6ff'
        sheet.lineWidth = 2
        sheet.setLineDash([8, 6])
        sheet.strokeRect(
          x + s.left * w,
          y + s.top * height,
          (1 - s.left - s.right) * w,
          (1 - s.top - s.bottom) * height,
        )
        sheet.restore()
      }
      sheet.fillStyle = '#e6e8ec'
      sheet.font = '14px sans-serif'
      const text = `${v.name}  ${f.t.toFixed(3)} s  ${v.width}×${v.height}`
      let shown = text
      while (shown.length > 4 && sheet.measureText(shown).width > w) shown = shown.slice(0, -2)
      sheet.fillText(shown === text ? text : `${shown}…`, x, y + height + 16)
    }
    x += w + PAD
  })
  return sheet.canvas.encode('png')
}
