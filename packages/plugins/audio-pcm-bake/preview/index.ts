// audio-pcm-bake: a chord made in code (preview/bed.ts, its pitches read from a listed input),
// baked once by the item's tools/pcm-bake.ts. The picture is the baked file's waveform with a
// playhead, and below it the stamp, line by line, as loadBaked checks it. The loop has three
// thirds, each the item's own loadBaked on a host: the film as it is (the stamp matches and the
// file plays), the seed changed (refused), and the input edited (refused), each with the plugin's
// own message.

import { type Host, sha256 } from '@shaderera/core'
import { readWav } from '../../audio-hall-ending/preview/signal.ts'
import { loadBaked } from '../../previews/src/audio/baked.ts'
import { createHouse, L, R, RED, type Word } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'

const BED = 'audio/pcm-bed.m4a'
const STAMP = 'audio/pcm-bed.stamp.json'
const MID = 290
const HALF = 120
const TOP = 470

type File = { path: string; sha256: string }
type Stamp = {
  source: File
  inputs: File[]
  params: { seed: number; duration: number }
  output: File & { peak: number }
}

const audioPcmBake: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`audio-pcm-bake has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const mono = `"${FONT.mono}"`

  // The item's call, as a film makes it, then the same call with the seed changed and with the
  // input edited: the two refusals are the plugin's own messages.
  const src = await loadBaked(host, BED)
  const stamp = JSON.parse(new TextDecoder().decode(await host.io.read(STAMP))) as Stamp
  const input = stamp.inputs[0] as File
  const edited = new TextEncoder().encode(
    new TextDecoder().decode(await host.io.read(input.path)).replace('440', '495'),
  )
  const on = (o: { seed?: number; read?: (p: string) => Promise<Uint8Array> }) =>
    ({
      seed: o.seed ?? host.seed,
      manifest: host.manifest,
      io: { read: o.read ?? ((p: string) => host.io.read(p)) },
    }) as unknown as Host
  const refusal = (h: Host) =>
    loadBaked(h, BED).then(
      () => 'opened',
      (e: Error) => e.message,
    )
  const third = duration / 3
  const phases = [
    {
      word: 'BAKED',
      verdict: 'PLAYS',
      message: `loadBaked → ${src}`,
      note: 'the stamp matches: open plays the file',
    },
    {
      word: `SEED ${host.seed + 1}`,
      verdict: 'REFUSED',
      message: await refusal(on({ seed: host.seed + 1 })),
      note: 'the seed changed: open refuses the old file',
    },
    {
      word: 'INPUT EDITED',
      verdict: 'REFUSED',
      message: await refusal(
        on({ read: (p) => (p === input.path ? Promise.resolve(edited) : host.io.read(p)) }),
      ),
      note: 'an input changed: open refuses the old file',
    },
  ]
  const editedHash = await sha256(edited)
  const top: Word[] = phases.map((p, i) => ({ from: i * third, to: (i + 1) * third, text: p.word }))
  const bottom: Word[] = phases.map((p, i) => ({
    from: i * third,
    to: (i + 1) * third,
    text: p.verdict,
  }))

  // The waveform, once: the peak per column.
  const wave = await readWav(host, 'audio/pcm-bed.wav')
  const columns = R - L
  const peaks = Float32Array.from({ length: columns }, (_, c) => {
    const a = Math.floor((c / columns) * wave.mono.length)
    const b = Math.floor(((c + 1) / columns) * wave.mono.length)
    let m = 0
    for (let i = a; i < b; i++) m = Math.max(m, Math.abs(wave.mono[i] ?? 0))
    return m
  })
  const loud = Math.max(...peaks)
  const short = (h: string) => `${h.slice(0, 16)}…`
  const db = (v: number) => `${(20 * Math.log10(v)).toFixed(1)} DBFS`

  const text = (s: string, x: number, y: number, color: string, size = 16) => {
    ctx.font = `${size}px ${mono}`
    ctx.textAlign = 'left'
    ctx.fillStyle = color
    ctx.fillText(s, x, y)
  }
  /** The plugin's message, wrapped to the picture's width. */
  const wrap = (s: string, y: number, color: string) => {
    ctx.font = `15px ${mono}`
    let line = ''
    for (const w of s.split(' ')) {
      if (line && ctx.measureText(`${line} ${w}`).width > R - L) {
        text(line, L, y, color, 15)
        y += 22
        line = w
      } else line = line ? `${line} ${w}` : w
    }
    text(line, L, y, color, 15)
  }

  return {
    async render(t, o) {
      const k = Math.min(2, Math.floor(t / third))
      const phase = phases[k] as (typeof phases)[number]
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()

      // The baked file, white where it has played, and the playhead.
      const head = L + (t / duration) * columns
      for (let c = 0; c < columns; c++) {
        const a = ((peaks[c] ?? 0) / loud) * HALF
        ctx.fillStyle = L + c <= head ? (k === 0 ? '#fff' : '#6a6a6a') : '#3a3a3a'
        ctx.fillRect(L + c, MID - a, 1, 2 * a)
      }
      ctx.fillStyle = k === 0 ? '#fff' : RED
      ctx.fillRect(Math.round(head) - 1, MID - HALF - 10, 2, 2 * HALF + 20)
      text(
        `${BED}   ${stamp.output.peak > 0 ? db(stamp.output.peak) : ''} PEAK`,
        L,
        MID + HALF + 34,
        '#8a8a8a',
        14,
      )

      // The stamp, as loadBaked checks it; the line that no longer matches in red.
      const rows: [string, string, string, boolean][] = [
        ['SOURCE', stamp.source.path, short(stamp.source.sha256), true],
        [
          'INPUT',
          input.path,
          k === 2 ? `${short(input.sha256)} ≠ ${short(editedHash)}` : short(input.sha256),
          k !== 2,
        ],
        ['SEED', String(stamp.params.seed), k === 1 ? `≠ ${host.seed + 1}` : '', k !== 1],
        ['DURATION', `${stamp.params.duration} S`, '', true],
        ['OUTPUT', stamp.output.path, short(stamp.output.sha256), true],
      ]
      text(STAMP.toUpperCase(), L, TOP, '#8a8a8a', 14)
      rows.forEach(([key, value, hash, ok], i) => {
        const y = TOP + 34 + i * 28
        text(key, L, y, ok ? '#8a8a8a' : RED)
        text(value, L + 130, y, ok ? '#fff' : RED)
        text(hash, L + 430, y, ok ? '#6a6a6a' : RED)
        ctx.textAlign = 'right'
        ctx.fillStyle = ok ? '#fff' : RED
        ctx.fillText(ok ? 'MATCHES' : 'CHANGED', R, y)
      })
      wrap(phase.message, TOP + 34 + rows.length * 28 + 16, k === 0 ? '#fff' : RED)

      house.words(top, bottom, t, o.frame)
      house.note(phase.note, R, 790)
      house.hud(t, o.frame, `${src}   ${phase.verdict}`, `SEED ${host.seed}   ${duration} S`)
      return [{ color: canvas }]
    },
    status(t) {
      return (
        phases[Math.min(2, Math.floor(t / third))] as (typeof phases)[number]
      ).verdict.toLowerCase()
    },
    inspect(t) {
      const p = phases[Math.min(2, Math.floor(t / third))] as (typeof phases)[number]
      return { id: 'bake', verdict: p.verdict, message: p.message }
    },
    async audio() {
      return [{ src, at: 0 }]
    },
  }
}

export default audioPcmBake
