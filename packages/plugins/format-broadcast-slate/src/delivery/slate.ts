/** What a slate states: one line each, in order. Values are the delivery's, never invented. */
export type SlateFields = { readonly [label: string]: string }

/**
 * Draws the slate at t < 0 (a preroll with `fill: 'source'`): the fields as label and value
 * lines on black, and the whole seconds left to the programme, until `blackFor` seconds before it,
 * then black. White on black at sizes from the frame's height, in the given font family.
 * Returns false at t >= 0, where the film draws itself.
 */
export const drawSlate = (
  ctx: OffscreenCanvasRenderingContext2D,
  t: number,
  o: { width: number; height: number; fields: SlateFields; family?: string; blackFor?: number },
): boolean => {
  if (t >= 0) return false
  const { width, height } = o
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, width, height)
  if (-t <= (o.blackFor ?? 2)) return true
  const family = o.family ?? 'sans-serif'
  const line = height / 16
  ctx.fillStyle = '#fff'
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  ctx.font = `${Math.round(line * 0.8)}px ${family}`
  const x = width * 0.1
  let y = height * 0.18
  for (const [label, value] of Object.entries(o.fields)) {
    ctx.fillText(`${label}: ${value}`, x, y)
    y += line * 1.3
  }
  ctx.textAlign = 'right'
  ctx.font = `${Math.round(line * 4)}px ${family}`
  ctx.fillText(String(Math.ceil(-t)), width * 0.9, height * 0.85)
  return true
}
