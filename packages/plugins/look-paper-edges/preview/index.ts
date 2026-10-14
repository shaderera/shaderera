// look-paper-edges: a printed page made in code (a dark-to-light iridescent ground under rows of
// mono type), and two pieces of it on the black: a strip torn at both ends and cut along its
// length, and a huge "A" cut out with scissors, a paper border around it and its hole filled. The
// pieces are torn and cut again four times a second from the next seed and the next paper stock,
// like stop motion; the six are built once, in open.

import { createHouse, iridescent, L, type Word } from '../../previews/src/house.ts'
import { cutout, PAPERS, type Piece, strip } from '../../previews/src/looks/paper.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'

type Ctx = OffscreenCanvasRenderingContext2D
const SEEDS = 6
/** The stock each seed is cut from, in turn. */
const STOCKS = ['white', 'cream', 'newsprint', 'kraft', 'coated', 'cream'] as const
const RATE = 4
const STRIP = { x: 540, y: 270, width: 860, height: 170, turn: -0.05, depth: 10, rim: 6, fibre: 2 }
const GLYPH = { x: 540, y: 600, size: 470, border: 14 }

const lookPaperEdges: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`look-paper-edges has no state "${stateId}"`)
  const { width, height } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as Ctx
  const house = createHouse(host, ctx)

  // The page the pieces are cut from.
  const page = host.io.canvas(width, height)
  const p = page.getContext('2d') as Ctx
  const ground = p.createLinearGradient(0, 0, width, height)
  for (let k = 0; k <= 4; k++) {
    const [r, g, b] = iridescent(k / 4)
    ground.addColorStop(
      k / 4,
      `rgb(${r * 255 * (0.35 + k * 0.12)}, ${g * 255 * (0.35 + k * 0.12)}, ${b * 255 * (0.35 + k * 0.12)})`,
    )
  }
  p.fillStyle = ground
  p.fillRect(0, 0, width, height)
  p.font = `34px "${FONT.monoBold}"`
  p.fillStyle = 'rgba(0,0,0,0.55)'
  for (let row = 0; row < 26; row++)
    p.fillText('CUT TORN FIBRE CORE PAPER PRINT SEED '.repeat(3), -row * 37, 40 + row * 42)
  const pagePx = p.getImageData(0, 0, width, height).data
  const at = (x: number, y: number) => {
    const xi = Math.min(width - 1, Math.max(0, Math.round(x)))
    const yi = Math.min(height - 1, Math.max(0, Math.round(y)))
    const i = (yi * width + xi) * 4
    return [pagePx[i] as number, pagePx[i + 1] as number, pagePx[i + 2] as number] as const
  }

  // The glyph's shape as an alpha, any shape would do.
  const gw = Math.round(GLYPH.size * 0.9)
  const gh = Math.round(GLYPH.size * 0.9)
  const shape = host.io.canvas(gw, gh)
  const s = shape.getContext('2d') as Ctx
  s.font = `${GLYPH.size}px "${FONT.monoBold}"`
  s.textAlign = 'center'
  s.textBaseline = 'middle'
  s.fillStyle = '#fff'
  s.fillText('A', gw / 2, gh / 2 + GLYPH.size * 0.04)
  const rgba = s.getImageData(0, 0, gw, gh).data
  const alpha = new Uint8Array(gw * gh)
  for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3] as number
  const gx = GLYPH.x - gw / 2
  const gy = GLYPH.y - gh / 2

  const pieces: { band: Piece; letter: Piece }[] = []
  for (let k = 0; k < SEEDS; k++)
    pieces.push({
      band: strip(host.io, {
        width: STRIP.width,
        height: STRIP.height,
        print: (x, y) => at(STRIP.x - STRIP.width / 2 + x, STRIP.y - STRIP.height / 2 + y),
        sides: { left: 'torn', right: 'torn', top: 'cut', bottom: 'cut' },
        depth: STRIP.depth,
        rim: STRIP.rim,
        fibre: STRIP.fibre,
        seed: k + 1,
        paper: PAPERS[STOCKS[k] ?? 'white'],
      }),
      letter: cutout(host.io, {
        width: gw,
        height: gh,
        alpha,
        print: (x, y) => at(gx + x, gy + y),
        border: GLYPH.border,
        edge: 'scissors',
        snip: 3 + k,
        holes: 'fill',
        seed: k + 1,
        paper: PAPERS[STOCKS[k] ?? 'white'],
      }),
    })

  const state = (t: number) => {
    const step = Math.floor(t * RATE)
    return { step, seed: (step % SEEDS) + 1 }
  }
  const top: Word[] = [{ from: 0, to: 99, text: 'TORN' }]
  const bottom: Word[] = [{ from: 0, to: 99, text: 'CUT' }]

  return {
    async render(t, o) {
      const { seed } = state(t)
      const { band, letter } = pieces[seed - 1] as (typeof pieces)[number]
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()
      ctx.save()
      ctx.shadowColor = 'rgba(0,0,0,0.6)'
      ctx.shadowBlur = 16
      ctx.shadowOffsetX = 4
      ctx.shadowOffsetY = 8
      ctx.drawImage(
        letter.canvas as unknown as CanvasImageSource,
        gx - letter.margin,
        gy - letter.margin,
      )
      ctx.translate(STRIP.x, STRIP.y)
      ctx.rotate(STRIP.turn)
      ctx.drawImage(
        band.canvas as unknown as CanvasImageSource,
        -STRIP.width / 2 - band.margin,
        -STRIP.height / 2 - band.margin,
      )
      ctx.restore()
      house.words(top, bottom, t, o.frame)
      house.note(`seed ${seed}, ${STOCKS[seed - 1]}`, L, 790, 'left')
      house.hud(
        t,
        o.frame,
        `DEPTH ${STRIP.depth}   RIM ${STRIP.rim}   FIBRE ${STRIP.fibre}   BORDER ${GLYPH.border} PX`,
        `SEED ${seed} / ${SEEDS}   ${RATE} A SECOND`,
      )
      return [{ color: canvas }]
    },
    status(t) {
      return `seed ${state(t).seed}`
    },
    inspect(t) {
      return { id: 'paper', seed: state(t).seed }
    },
  }
}

export default lookPaperEdges
