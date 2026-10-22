// asset-provenance: four files recorded by the plugin's own tool (preview/make.ts), then the
// credits it made from them. For the first half, each file arrives as a row: its path, its title,
// author and licence, and its sha256 decoding in from noise. For the second half, the rows give way
// to the description's credits, line by line, then the share-alike note, with the check's exit
// code in the corner. Everything shown is what the tool wrote; red marks the share-alike work.

import { createHouse, L, R, RED, scramble } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'

/** The fields of a provenance record the picture shows. */
type Shown = {
  file: string
  sha256: string
  title: string
  author: string
  licence: string
  flags?: string[]
}
type Data = { records: Shown[]; credits: string; check: { exitCode: number } }

const DATA = 'audio/asset-provenance/preview.json'
/** When each row arrives, and when the credits take over. */
const ROW = (i: number) => 0.35 + i * 0.6
const CREDITS = 3.1
/** As the tool decides it: the flag, or a licence that says so. */
const shareAlike = (r: Shown) =>
  r.flags?.includes('share-alike') === true || /\bSA\b|share-?alike/i.test(r.licence)

const assetProvenance: OpenPreview = async (host, state) => {
  if (state !== 'default') throw new Error(`asset-provenance has no state "${state}"`)
  const data = JSON.parse(new TextDecoder().decode(await host.io.read(DATA))) as Data
  if (data.records.length === 0) throw new Error(`${DATA} has no records; run its preview/make.ts`)
  const [lines, note] = data.credits.split('\n\n') as [string, string | undefined]
  const credits = lines.split('\n')
  const { width, height, duration } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const theme = createHouse(host, ctx)

  /** Text set in one line, shrunk to fit between the margins. */
  const fitted = (
    text: string,
    x: number,
    y: number,
    size: number,
    font: string,
    color: string,
  ) => {
    ctx.font = `${size}px "${font}"`
    const s = Math.min(size, (size * (R - x)) / Math.max(1, ctx.measureText(text).width))
    ctx.font = `${s}px "${font}"`
    ctx.fillStyle = color
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(text, x, y)
  }
  /** Words wrapped to the margins. */
  const wrapped = (text: string, y: number, size: number) => {
    ctx.font = `${size}px "${FONT.serif}"`
    let line = ''
    let at = y
    for (const word of text.split(' ')) {
      const next = line ? `${line} ${word}` : word
      if (ctx.measureText(next).width > R - L - 40 && line) {
        theme.note(line, L + 40, at, 'left', size)
        line = word
        at += size * 1.25
      } else line = next
    }
    theme.note(line, L + 40, at, 'left', size)
  }
  const marker = (y: number) => {
    ctx.fillStyle = RED
    ctx.fillRect(L, y - 18, 14, 14)
  }

  return {
    async render(t, o) {
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      theme.index()
      const recording = t < CREDITS
      if (recording) {
        data.records.forEach((r, i) => {
          const age = t - ROW(i)
          if (age < 0) return
          const y = 210 + i * 132
          const p = Math.min(1, age / 0.45)
          if (shareAlike(r)) marker(y)
          fitted(
            scramble(r.file, Math.min(1, age / 0.2), o.frame, i),
            L + 40,
            y,
            30,
            FONT.monoBold,
            '#fff',
          )
          fitted(
            `${r.title} · ${r.author} · ${r.licence}`,
            L + 40,
            y + 34,
            20,
            FONT.mono,
            '#bdbdbd',
          )
          fitted(
            `sha256 ${scramble(r.sha256, p, o.frame, 40 + i)}`,
            L + 40,
            y + 62,
            17,
            FONT.monoLight,
            '#8a8a8a',
          )
        })
      } else {
        // Everything scrambles out over the last 0.3 s, so the loop's seam lands on an empty frame.
        const leaving = Math.min(1, (duration - t) / 0.3)
        credits.forEach((line, i) => {
          const age = t - CREDITS - 0.15 - i * 0.25
          if (age < 0) return
          const y = 220 + i * 70
          const sa = data.records.find((r) => line.includes(r.licence) && shareAlike(r))
          if (sa) marker(y)
          fitted(
            scramble(line, Math.min(age / 0.35, leaving), o.frame, 80 + i),
            L + 40,
            y,
            22,
            FONT.mono,
            '#e8e8e8',
          )
        })
        if (note && t > CREDITS + 1.4 && leaving >= 1)
          wrapped(note, 220 + credits.length * 70 + 40, 30)
      }
      theme.bigWord({
        text: recording ? 'record' : 'credits',
        corner: 'tl',
        since: recording ? t : t - CREDITS,
        until: recording ? CREDITS - t : duration - t,
        frame: o.frame,
      })
      const files = data.records.filter((_, i) => t >= ROW(i)).length
      theme.bigWord({
        text: recording
          ? `${files} ${files === 1 ? 'file' : 'files'}`
          : `check exit ${data.check.exitCode}`,
        corner: 'br',
        since: recording ? t : t - CREDITS,
        until: recording ? CREDITS - t : duration - t,
        frame: o.frame,
        size: 56,
      })
      theme.hud(t, o.frame, recording ? 'PROVENANCE/*.JSON' : 'OUT/CREDITS.TXT')
      return [{ color: canvas }]
    },
    status: (t) => (t < CREDITS ? 'record' : 'credits'),
    inspect: (t) => ({ id: 'provenance', phase: t < CREDITS ? 'record' : 'credits' }),
  }
}

export default assetProvenance
