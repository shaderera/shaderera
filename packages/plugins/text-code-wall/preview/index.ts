// text-code-wall: the item's wall built from the previews' own source, twice a loop, in the house
// style. Each wall stands for 3 s (32 sixteenths at 160 BPM): its rows arrive top to bottom, the
// files scroll side by side and jump on every sixteenth, lines thrown, scrambled and lit, a claim
// decodes in the hole cut out of the middle (the item's own big words), and in the last beat the
// rows drop out at random. The second wall reads other files and makes another claim; the first
// follows the second, so the loop has no seam. Everything on screen is the code it shows.

import { createHouse, PICTURE, RED, type Word } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'
import { type CodeFile, createCodeWall, readCode } from '../../previews/src/type/code-wall.ts'

const BPM = 160
const SIXTEENTH = 60 / BPM / 4
const WALL = 32 * SIXTEENTH

const WALLS: { files: string[]; claim: string[]; note: string }[] = [
  {
    files: ['src/type/code-wall.ts', 'src/type/scramble.ts', 'src/house.ts'],
    claim: ['EVERYTHING', 'IS SOURCE CODE'],
    note: '160 BPM, a jump on every 1/16',
  },
  {
    files: ['src/house.ts', 'src/composition.ts', 'src/caption.ts'],
    claim: ['THIS PREVIEW', 'READS ITSELF'],
    note: 'the wall is the code drawing it',
  },
]

const textCodeWall: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`text-code-wall has no state "${stateId}"`)
  const { width, height } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const wallCanvas = host.io.canvas(width, PICTURE)
  const wallCtx = wallCanvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const theme = createHouse(host, ctx)
  const files: CodeFile[][] = await Promise.all(WALLS.map((w) => readCode(host, w.files)))
  const lines = files.map((f) => f.reduce((n, x) => n + x.lines.length, 0))
  const walls = WALLS.map((w, i) =>
    createCodeWall({
      files: files[i] ?? [],
      start: i * WALL,
      end: (i + 1) * WALL,
      step: SIXTEENTH,
      claim: w.claim,
      // The default note names every path in full, wider than the hole at this size.
      note: `${(files[i] ?? []).map((f) => f.name.split('/').pop()).join(' + ')} · ${lines[i] ?? 0} lines`,
      fonts: { mono: `"${FONT.mono}"`, claim: `"${FONT.monoBold}"` },
    }),
  )
  const notes: Word[] = WALLS.map((w, i) => ({
    from: i * WALL + 2 * SIXTEENTH,
    to: (i + 1) * WALL - 4 * SIXTEENTH,
    text: w.note,
  }))

  const state = (t: number) => {
    const wall = Math.min(WALLS.length - 1, Math.floor(t / WALL))
    const step = Math.floor((t - wall * WALL) / SIXTEENTH)
    return { wall, step }
  }

  return {
    async render(t, o) {
      const s = state(t)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      theme.index()
      wallCtx.clearRect(0, 0, width, PICTURE)
      for (const wall of walls) wall(wallCtx, width, PICTURE, t, o.frame)
      ctx.drawImage(wallCanvas, 0, 0)
      theme.wash(width)
      // The labels and the note sit in holes cut out of the wall, as the claim does.
      ctx.fillStyle = '#000'
      ctx.fillRect(width - 260, 10, 260, 66)
      ctx.fillRect(40, 110, 80, 26)
      ctx.fillRect(40, 842, 250, 48)
      ctx.fillRect(width - 420, 836, 420, 46)
      // The note, between walls blank (each wall's rows drop out before the next arrives).
      if (t >= (notes[s.wall]?.from ?? 0) && t < (notes[s.wall]?.to ?? 0))
        theme.notes(notes, t, o.frame, 1032, 870)
      // The sixteenth it is on: a red marker along the picture's foot that steps with the jumps.
      ctx.fillStyle = RED
      const cell = width / 32
      ctx.fillRect(s.step * cell, PICTURE - 5, cell - 2, 5)
      theme.hud(
        t,
        o.frame,
        `WALL ${s.wall + 1}/2   ${lines[s.wall] ?? 0} LINES`,
        `STEP ${String(s.step + 1).padStart(2, '0')}/32`,
      )
      return [{ color: canvas }]
    },
    status(t) {
      const s = state(t)
      return `wall ${s.wall + 1}/2  step ${String(s.step + 1).padStart(2, '0')}/32`
    },
    inspect(t) {
      const s = state(t)
      const w = WALLS[s.wall]
      return {
        id: 'wall',
        files: (files[s.wall] ?? []).map((f) => ({ id: f.name, lines: f.lines.length })),
        claim: w?.claim ?? [],
        step: s.step,
      }
    },
  }
}

export default textCodeWall
