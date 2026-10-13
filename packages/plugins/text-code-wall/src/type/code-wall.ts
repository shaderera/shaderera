// The film's own source as a wall of text: files side by side, each scrolling at its own rate and
// jumping on every step of the music, lines thrown and scrambled, one in thirty lit. A claim is
// cut out of the middle. Everything on screen is this code.

import type { Host } from '@shaderera/core'
import { decoded, glitched, rnd, scramble } from './kinetic.ts'

type Ctx = OffscreenCanvasRenderingContext2D

export type CodeFile = { name: string; lines: string[] }

/** Reads source files through the host (paths from the project root), without blank lines. */
export const readCode = async (host: Host, paths: string[]): Promise<CodeFile[]> =>
  Promise.all(
    paths.map(async (name) => ({
      name,
      lines: new TextDecoder()
        .decode(await host.io.read(name))
        .split(/\r?\n/)
        .filter((l) => l.trim()),
    })),
  )

export type CodeWallOptions = {
  files: CodeFile[]
  from: number
  to: number
  /** The jump period: a 1/16 of the music reads as the machine running. */
  step: number
  /** The claim, a line each; none for the wall alone. */
  claim?: string[]
  /** A small line under the claim; by default the files and their line count. */
  note?: string
  /** CSS font families, quoted. */
  fonts: { mono: string; claim: string }
}

export const createCodeWall = (o: CodeWallOptions) => {
  const total = o.files.reduce((n, f) => n + f.lines.length, 0)
  const noteText =
    o.note ??
    `${o.files.map((f) => f.name).join(' + ')} · ${total.toLocaleString('en-US')} lines · deterministic, frame for frame`

  /** Draws the wall at t onto ctx, if t is inside it (it does not clear the canvas). */
  return (ctx: Ctx, W: number, H: number, t: number, frame: number) => {
    if (t < o.from || t >= o.to) return
    const s = Math.min(W, H) / 1080
    const size = Math.max(10, Math.round(15 * s))
    const lead = Math.round(size * 1.27)
    const pad = Math.round(36 * s)
    const rows = Math.ceil((H - 2 * pad) / lead)
    const k = Math.floor((t - o.from) / o.step)
    const built = Math.min(1, (t - o.from) / (2 * o.step)) // rows arrive top to bottom…
    const beat = 4 * o.step
    const gone = Math.min(1, Math.max(0, (t - (o.to - beat)) / beat)) // …and drop out at random
    const cols = W > H ? o.files.length : 1 // a tall frame shows one file at a time
    const shown = cols === 1 ? [o.files[k % o.files.length] ?? o.files[0]] : o.files
    const colW = (W - 2 * pad) / cols
    const chars = Math.floor((colW - 24) / (size * 0.6))
    ctx.font = `${size}px ${o.fonts.mono}`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    shown.forEach((file, c) => {
      if (!file) return
      const scroll = Math.floor((t - o.from) * (34 + 21 * c)) + k * (7 + c * 5)
      for (let r = 0; r < rows; r++) {
        if (r / rows > built || rnd(r * 977 + c * 31 + 5) < gone) continue
        const y = pad + r * lead
        const x = pad + c * colW
        const head = r === 0
        let line = head
          ? `// ${file.name} · ${file.lines.length} lines`
          : (file.lines[(scroll + r) % file.lines.length] ?? '')
        line = line.replace(/\t/g, '  ').slice(0, chars)
        const g = rnd(frame * 7 + r * 131 + c * 17)
        const throwX = g < 0.12 ? (rnd(frame * 3 + r) - 0.5) * 160 * s : 0
        if (g > 0.965 && !head) {
          ctx.fillStyle = 'rgba(255,255,255,0.95)'
          ctx.fillRect(
            x - 4 + throwX,
            y - 2,
            Math.min(colW - 16, line.length * size * 0.6 + 8),
            lead,
          )
          ctx.fillStyle = '#05070a'
        } else
          ctx.fillStyle = head
            ? 'rgba(255,255,255,0.95)'
            : `rgba(222,230,242,${0.35 + 0.35 * rnd(r * 13 + c)})`
        ctx.fillText(g < 0.3 ? scramble(line, frame + r, 0.25) : line, x + throwX, y)
      }
    })

    // The claim, cut out of the code, for as long as the wall stands.
    const claim = o.claim ?? []
    const from = o.from + 2 * o.step
    const to = o.to - o.step
    if (claim.length === 0 || t < from || t >= to) return
    const longest = Math.max(...claim.map((x) => x.length))
    const size2 = Math.round(Math.min(H * 0.105, (W * 0.86) / (longest * 0.6)))
    // The family is the bold face: a weight here would land after the size, an invalid font.
    const bold = o.fonts.claim
    ctx.font = `${size2}px ${bold}`
    const w = Math.max(...claim.map((l) => ctx.measureText(l).width)) + size2
    const h = size2 * (claim.length + 0.6)
    ctx.clearRect(W / 2 - w / 2, H / 2 - h / 2, w, h)
    claim.forEach((l, i) => {
      const d = decoded(l, t, { from: from + i * 2 * o.step, to, frame, seed: 40 + i })
      ctx.fillStyle = 'rgba(255,255,255,0.96)'
      glitched(ctx, d.text, W / 2, H / 2 + (i - (claim.length - 1) / 2) * size2 * 1.1, {
        font: bold,
        size: size2,
        frame,
        align: 'center',
        amount: d.settled ? 0.25 : 1,
      })
    })
    ctx.font = `${Math.max(10, Math.round(13 * s))}px ${o.fonts.mono}`
    ctx.fillStyle = 'rgba(222,230,242,0.82)'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    const n = decoded(noteText, t, { from: from + beat / 2, to, frame, seed: 50 })
    ctx.fillText(n.text, W / 2, H / 2 + h / 2 - 22 * s, W - 2 * pad)
  }
}
