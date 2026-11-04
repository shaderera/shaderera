// Re-paces a narration: every pause between words longer than --max-pause is shortened to it,
// from its middle, with a short crossfade at the join; the pauses named with --keep are left as
// they are; then --tempo changes the speed with ffmpeg's rubberband filter, the pitch kept. The
// word times come in as any file text-timed-cues reads that has words (a speech-to-text transcript,
// Whisper's segments, enhanced LRC). Run from the project root, with the recording inside it.
// Needs ffmpeg and ffprobe on PATH, and an ffmpeg built with librubberband for --tempo.
//
//   node tools/voice-repace.ts audio/voice.wav words/voice.json --out audio/voice-paced.wav
//     [--max-pause 0.3] [--keep 18.2,21.5] [--cut 40.1-44.8] [--tempo 1] [--fade 0.01]
//
// --max-pause the longest pause left between two words, in seconds
// --keep      a time inside each pause to leave alone (a reveal, a title), original seconds
// --cut       stretches to take out whatever they hold (a flubbed take), from-to in original
//             seconds, comma-separated; each edge moves to the quietest 20 ms within 50 ms
// --tempo     the speed after the pauses: under 1 slower, over 1 faster
// --fade      the crossfade at each join, in seconds; shorter than --max-pause
//
// Writes the new audio (48 kHz, 24-bit WAV) and, beside it, <out>.map.json: a
// shaderera.analysis/1 time-map whose knots [old seconds, new seconds] src/audio/repace.ts reads.

import { sha256 } from '@shaderera/core'
import { parseTimedText, type Word } from '../src/type/timed-text.ts'

export type Repace = {
  maxPause: number
  keep: readonly number[]
  tempo: number
  fade: number
  /** Stretches to take out whatever they hold (a flubbed take), [from, to] in original seconds. */
  cut?: readonly (readonly [number, number])[]
}

const RATE = 48000

/**
 * The centre of the quietest 20 ms within ±50 ms of `t`, in 5 ms steps, all channels summed: where
 * a named cut's edge lands, so it falls between words and not inside one.
 */
export const quietest = (pcm: Float32Array, channels: number, rate: number, t: number) => {
  const frames = pcm.length / channels
  const half = Math.round(0.01 * rate)
  let best = Number.POSITIVE_INFINITY
  let at = t
  for (let k = -10; k <= 10; k++) {
    const c = t + k * 0.005
    const i = Math.round(c * rate)
    if (c < 0 || i > frames) continue
    let e = 0
    for (let j = Math.max(0, i - half); j < Math.min(frames, i + half); j++)
      for (let ch = 0; ch < channels; ch++) e += (pcm[j * channels + ch] as number) ** 2
    if (e < best) {
      best = e
      at = c
    }
  }
  return Math.round(at * 1e6) / 1e6
}

/** Stretches in seconds, sorted, with any that overlap or touch joined into one. */
const joined = (cuts: readonly (readonly [number, number])[]) =>
  [...cuts]
    .sort((x, y) => x[0] - y[0])
    .reduce<[number, number][]>((all, [a, b]) => {
      const last = all[all.length - 1]
      if (last && a <= last[1]) last[1] = Math.max(last[1], b)
      else all.push([a, b])
      return all
    }, [])

/** The stretches of the original, in seconds, that come out: the middle of each long, unkept pause. */
export const cutsOf = (words: readonly Word[], o: Pick<Repace, 'maxPause' | 'keep'>) => {
  const sorted = [...words].sort((a, b) => a.start - b.start)
  const cuts: [number, number][] = []
  // A pause starts when every earlier word has ended: words can overlap, or sit inside another.
  let end = sorted[0]?.end ?? 0
  for (const word of sorted.slice(1)) {
    const from = end
    const to = word.start
    end = Math.max(end, word.end)
    const gap = to - from
    if (gap <= o.maxPause || o.keep.some((k) => k >= from && k <= to)) continue
    const mid = (from + to) / 2
    cuts.push([mid - (gap - o.maxPause) / 2, mid + (gap - o.maxPause) / 2])
  }
  return cuts
}

/**
 * The recording re-paced, before the tempo change, and the time map after it: interleaved samples
 * in, the cuts taken out with a crossfade of `fade` centred on each join, and knots
 * [old seconds, new seconds] with the new times divided by the tempo.
 */
export const repace = (
  pcm: Float32Array,
  channels: number,
  rate: number,
  words: readonly Word[],
  o: Repace,
) => {
  if (!(o.fade >= 0 && o.fade < o.maxPause))
    throw new Error(`--fade ${o.fade} must be from 0 to under --max-pause ${o.maxPause}`)
  if (!(o.tempo > 0)) throw new Error(`--tempo ${o.tempo} must be over 0`)
  const frames = pcm.length / channels
  const named = (o.cut ?? []).map(([a, b]) => {
    if (!(a >= 0 && b > a)) throw new Error(`--cut ${a}-${b} must run forward from 0 or later`)
    return [
      a === 0 ? 0 : quietest(pcm, channels, rate, a),
      quietest(pcm, channels, rate, b),
    ] as const
  })
  const pauses = cutsOf(words, o)
  const cuts = joined([...pauses, ...named]).map(
    ([a, b]) =>
      [Math.round(a * rate), Math.round(b * rate)].map((i) => Math.max(0, Math.min(frames, i))) as [
        number,
        number,
      ],
  )
  const out = new Float32Array(pcm.length - cuts.reduce((n, [a, b]) => n + (b - a) * channels, 0))
  const half = Math.round((o.fade * rate) / 2)
  const s = (x: number) => Math.round((x / rate) * 1e6) / 1e6
  const knots: [number, number][] = [[0, 0]]
  const joins: [number, number, number][] = []
  let from = 0
  let at = 0
  for (const [a, b] of cuts) {
    out.set(pcm.subarray(from * channels, a * channels), at * channels)
    at += a - from
    knots.push([s(a), s(at)], [s(b), s(at)])
    joins.push([at, a, b])
    from = b
  }
  out.set(pcm.subarray(from * channels), at * channels)
  // Each join: the end of the piece before fades into the start of the piece after.
  for (const [join, a, b] of joins)
    for (let j = -half; j < half; j++) {
      const r = (j + half + 0.5) / (2 * half)
      for (let c = 0; c < channels; c++)
        out[(join + j) * channels + c] =
          (pcm[(a + j) * channels + c] ?? 0) * (1 - r) + (pcm[(b + j) * channels + c] ?? 0) * r
    }
  knots.push([s(frames), s(at + frames - from)])
  return {
    pcm: out,
    cuts: cuts.length,
    pauses: pauses.length,
    named: named.length,
    knots: knots.map(([x, y]) => [x, Math.round((y / o.tempo) * 1e6) / 1e6] as [number, number]),
  }
}

if (import.meta.main) {
  const { execFileSync } = await import('node:child_process')
  const { mkdirSync, readFileSync, writeFileSync } = await import('node:fs')
  const { dirname, isAbsolute, relative, resolve } = await import('node:path')
  const { parseArgs } = await import('node:util')
  const fail = (message: string): never => {
    console.error(message)
    process.exit(2)
  }
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      'max-pause': { type: 'string', default: '0.3' },
      keep: { type: 'string', default: '' },
      cut: { type: 'string', default: '' },
      tempo: { type: 'string', default: '1' },
      fade: { type: 'string', default: '0.01' },
    },
  })
  const [audio, wordsFile] = positionals
  if (!audio || !wordsFile || !values.out?.toLowerCase().endsWith('.wav'))
    fail(
      'Usage: node tools/voice-repace.ts <audio> <words> --out <new.wav> [--max-pause 0.3] [--keep <s,s>] [--cut <from-to,...>] [--tempo 1] [--fade 0.01]',
    )
  const inProject = (p: string) => {
    const rel = relative(process.cwd(), resolve(p)).replaceAll('\\', '/')
    if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel))
      fail(`${p} is outside this project: run from the project root, with the file inside it`)
    return rel
  }
  const path = inProject(audio as string)
  const out = inProject(values.out as string)
  const map = out.replace(/\.wav$/i, '.map.json')
  const o: Repace = {
    maxPause: Number(values['max-pause']),
    keep: (values.keep as string).split(',').filter(Boolean).map(Number),
    tempo: Number(values.tempo),
    fade: Number(values.fade),
  }
  if (o.keep.some((k) => !Number.isFinite(k)))
    fail(`--keep ${values.keep} must be seconds, comma-separated`)
  const spans = (values.cut as string).split(',').filter(Boolean)
  o.cut = spans.map((span) => {
    const m = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(span.trim())
    if (!m) return fail(`--cut ${span} must be from-to in seconds, such as 40.1-44.8`)
    return [Number(m[1]), Number(m[2])] as const
  })
  const words = parseTimedText(
    wordsFile as string,
    readFileSync(wordsFile as string, 'utf8'),
  ).flatMap((c) => c.words ?? [])
  if (words.length === 0) fail(`${wordsFile} has no word times: give a transcript with words`)

  const probe = (p: string, entry: string) =>
    Number(
      execFileSync('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        entry,
        '-of',
        'default=nw=1:nk=1',
        p,
      ])
        .toString()
        .trim()
        .split(/\s+/)[0],
    )
  const channels = probe(path, 'stream=channels')
  const raw = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      path,
      '-f',
      'f32le',
      '-ar',
      String(RATE),
      '-ac',
      String(channels),
      'pipe:1',
    ],
    {
      maxBuffer: Number.POSITIVE_INFINITY,
    },
  )
  const pcm = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
  const paced = repace(pcm, channels, RATE, words, o)
  mkdirSync(dirname(out), { recursive: true })
  execFileSync(
    'ffmpeg',
    [
      ...[
        '-v',
        'error',
        '-y',
        '-f',
        'f32le',
        '-ar',
        String(RATE),
        '-ac',
        String(channels),
        '-i',
        'pipe:0',
      ],
      ...(o.tempo === 1
        ? []
        : ['-af', `rubberband=tempo=${o.tempo}:pitchq=quality:transients=smooth`]),
      ...['-c:a', 'pcm_s24le', out],
    ],
    { input: new Uint8Array(paced.pcm.buffer) },
  )
  const bytes = new Uint8Array(readFileSync(path))
  const doc = {
    format: 'shaderera.analysis/1',
    kind: 'time-map',
    source: {
      path,
      bytes: bytes.length,
      sha256: await sha256(bytes),
      seconds: pcm.length / channels / RATE,
    },
    output: { path: out, seconds: probe(out, 'format=duration') },
    tool: {
      script: 'tools/voice-repace.ts',
      ffmpeg: execFileSync('ffmpeg', ['-version']).toString().split('\n')[0]?.trim(),
    },
    params: { words: wordsFile, ...o },
    knots: paced.knots,
  }
  writeFileSync(map, `${JSON.stringify(doc, null, 2)}\n`)
  console.log(
    `${out}: ${doc.source.seconds.toFixed(2)} s -> ${doc.output.seconds.toFixed(2)} s, ${paced.pauses} pauses shortened${paced.named ? `, ${paced.named} stretch${paced.named === 1 ? '' : 'es'} cut` : ''}; ${map}`,
  )
}
