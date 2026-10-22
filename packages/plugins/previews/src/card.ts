// The plain test card the looks previews pass through their plugin: a grey checker, a grid of
// small lights, a ring, a grey step wedge along its top and a box with a grey ramp turning once a
// loop, on black (or another ground), drawn with Canvas2D. The wedge is at the top so its white end
// never sits under the house's bottom-right word. A stand-in subject, not a scene: what changes it is
// the plugin.

type Ctx = OffscreenCanvasRenderingContext2D

/** The card's square, and the turning box's centre and size. */
export const CARD = { x: 160, y: 150, size: 760 }
const BOX = { x: 540, y: 430, size: 230 }
const STEPS = 11

/**
 * Draws the card at t into ctx (the frame's size) on `ground`; the box turns once in `duration`.
 */
export const drawCard = (ctx: Ctx, t: number, duration: number, ground = '#000') => {
  const { width, height } = ctx.canvas
  ctx.fillStyle = ground
  ctx.fillRect(0, 0, width, height)
  const cell = CARD.size / 8
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      ctx.fillStyle = (x + y) % 2 ? '#3a3a3a' : '#262626'
      ctx.fillRect(CARD.x + x * cell, CARD.y + y * cell, cell, cell)
    }
  ctx.fillStyle = '#fff'
  for (let y = 0; y < 6; y++)
    for (let x = 0; x < 7; x++) {
      ctx.beginPath()
      ctx.arc(CARD.x + (x + 0.5) * (CARD.size / 7), CARD.y + 90 + (y + 0.5) * 92, 4, 0, Math.PI * 2)
      ctx.fill()
    }
  ctx.strokeStyle = '#9a9a9a'
  ctx.lineWidth = 10
  ctx.beginPath()
  ctx.arc(BOX.x, BOX.y, 210, 0, Math.PI * 2)
  ctx.stroke()
  ctx.save()
  ctx.translate(BOX.x, BOX.y)
  ctx.rotate((t / duration) * Math.PI * 2)
  const ramp = ctx.createLinearGradient(-BOX.size / 2, 0, BOX.size / 2, 0)
  ramp.addColorStop(0, '#3a3a3a')
  ramp.addColorStop(1, '#e6e6e6')
  ctx.fillStyle = ramp
  ctx.fillRect(-BOX.size / 2, -BOX.size / 2, BOX.size, BOX.size)
  ctx.restore()
  const w = CARD.size / STEPS
  for (let k = 0; k < STEPS; k++) {
    const v = Math.round((255 * k) / (STEPS - 1))
    ctx.fillStyle = `rgb(${v},${v},${v})`
    ctx.fillRect(CARD.x + k * w, CARD.y, w + 0.5, 90)
  }
}
