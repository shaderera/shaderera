// The plain test card the looks previews pass through their plugin: a grey checker, a grid of
// small lights, a ring, a grey step wedge and a box with a grey ramp turning once a loop, on black
// (or another ground), drawn with Canvas2D. The wedge is at the top by default, so its white end
// never sits under the house's bottom-right word. A stand-in subject, not a scene: what changes it
// is the plugin.

type Ctx = OffscreenCanvasRenderingContext2D

/** The card's square, and the turning box's centre and size. */
export const CARD = { x: 160, y: 150, size: 760 }
const BOX = { x: 540, y: 430, size: 230 }
const STEPS = 11
const WEDGE = 90

export type CardOptions = {
  /** The frame's ground behind the card; black by default. */
  ground?: string
  /** Where the step wedge runs: along the card's top (the default) or its foot. */
  wedge?: 'top' | 'bottom'
  /** The wedge's last step, 0–255: 255 by default; lower keeps the small lights the only highlights. */
  white?: number
}

/**
 * Draws the card at t into ctx (the frame's size); the box turns once in `duration`. The lights
 * fill the card but the wedge's band: 6 rows under a top wedge, 7 over a bottom one.
 */
export const drawCard = (ctx: Ctx, t: number, duration: number, o: CardOptions = {}) => {
  const { ground = '#000', wedge = 'top', white = 255 } = o
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
  const top = wedge === 'top' ? WEDGE : 0
  const rows = wedge === 'top' ? 6 : 7
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < 7; x++) {
      ctx.beginPath()
      ctx.arc(
        CARD.x + (x + 0.5) * (CARD.size / 7),
        CARD.y + top + (y + 0.5) * 92,
        4,
        0,
        Math.PI * 2,
      )
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
  const y = wedge === 'top' ? CARD.y : CARD.y + CARD.size - WEDGE
  const w = CARD.size / STEPS
  for (let k = 0; k < STEPS; k++) {
    const v = Math.round((white * k) / (STEPS - 1))
    ctx.fillStyle = `rgb(${v},${v},${v})`
    ctx.fillRect(CARD.x + k * w, y, w + 0.5, WEDGE)
  }
  // A grey frame round the wedge, so its black first step reads against a black ground.
  ctx.strokeStyle = '#3a3a3a'
  ctx.lineWidth = 2
  ctx.strokeRect(CARD.x + 1, y + 1, CARD.size - 2, WEDGE - 2)
}
