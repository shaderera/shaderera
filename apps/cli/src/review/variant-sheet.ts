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

/**
 * The label's font size: about 3% of the row height, at least 14 px, and at least 14 px still when
 * the sheet is scaled down to 1024 px wide (the size an agent is most often shown it at).
 */
export const labelSize = (rowHeight: number, sheetWidth: number) =>
  Math.max(14, Math.round(rowHeight * 0.03), Math.ceil((14 * sheetWidth) / 1024))

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
  const width = PAD + widths.reduce((sum, w) => sum + w + PAD, 0)
  const font = labelSize(height, width)
  const inset = Math.round(font * 0.4)
  const label = font + 2 * inset
  const sheet = createCanvas(width, PAD + times.length * (height + label + PAD)).getContext('2d')
  sheet.fillStyle = '#16181c'
  sheet.fillRect(0, 0, sheet.canvas.width, sheet.canvas.height)
  let x = PAD
  variants.forEach((v, i) => {
    const w = widths[i] as number
    const full = createCanvas(v.width, v.height).getContext('2d')
    for (const f of v.frames) {
      const y = PAD + times.indexOf(f.t) * (height + label + PAD)
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
      // White on black under the frame, padded: legible at any scale the sheet is shown at.
      sheet.fillStyle = '#000000'
      sheet.fillRect(x, y + height, w, label)
      sheet.fillStyle = '#ffffff'
      sheet.font = `bold ${font}px Arial, Helvetica, "DejaVu Sans", sans-serif`
      sheet.textBaseline = 'middle'
      const text = `${v.name}  ${f.t.toFixed(3)} s  ${v.width}×${v.height}`
      const fits = (s: string) => sheet.measureText(s).width <= w - 2 * inset
      let shown = text
      if (!fits(text)) {
        while (shown.length > 1 && !fits(`${shown}…`)) shown = shown.slice(0, -1)
        shown = `${shown}…`
      }
      sheet.fillText(shown, x + inset, y + height + label / 2)
    }
    x += w + PAD
  })
  return sheet.canvas.encode('png')
}
