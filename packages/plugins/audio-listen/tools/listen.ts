// Hears a recording and keeps the takes that match a description as trims. Each take (a stroke
// from its onset until it has decayed, or a plain window for beds) is scored with CLAP
// (laion/larger_clap_general, Apache-2.0, run on the CPU by transformers.js) against the
// description and against a background of other sound descriptions, so a score says whether the
// description fits this take better than the others. Each take's peak, the loudest 5 ms, is
// measured on the decoded file. Writes a shaderera.analysis/1 sound-trims artifact stamped with the
// recording's sha256, which src/audio/trims.ts reads. Run from the project root, with the recording
// inside it. Needs ffmpeg on PATH. The model (about 780 MB) is downloaded on first use into
// ~/.shaderera/models.
//
//   node tools/listen.ts audio/keys.wav "a single mechanical key press" [--top 5]
//     [--kind event|texture] [--win 2] [--not "a mouse click"]... [--out audio/keys.trims.json]
//
// --top   how many takes, best first
// --kind  event: one take per onset, until it has decayed (hits, clicks, steps; the default);
//         texture: plain windows of --win seconds, half overlapping (beds, ambiences)
// --win   the window for texture, in seconds
// --not   a description the take must fit worse than yours (what it could be mistaken for);
//         repeat for several
// --out   the artifact (default: beside the recording, <name>.trims.json)

import { hex, type Trim } from '../src/audio/trims.ts'

/** The model, pinned to one revision and precision so every run reads the same weights. */
const MODEL = {
  id: 'Xenova/larger_clap_general',
  revision: 'd78c3994912c441f0151a5cc44d86f6b7bf4c861',
  dtype: 'fp32',
  from: 'laion/larger_clap_general',
  licence: 'Apache-2.0',
}
/** The weights loaded, as they lie in the cache: each is stamped with its sha256. */
const WEIGHTS = ['onnx/text_model.onnx', 'onnx/audio_model.onnx']
const TRANSFORMERS = '@huggingface/transformers'
const RATE = 48000
/** The level envelope's frame and hop, in seconds. */
const FRAME = 0.005
/** At most this many strokes are scored, the loudest ones: each costs about a second. */
const MOST = 150

/**
 * What a take is compared with besides the description: if one of these fits it better, the take
 * ranks below first. Plain, varied, everyday sounds.
 */
export const BACKGROUND = [
  'a mechanical keyboard key press',
  'typing on a keyboard',
  'a mouse click',
  'a door knock',
  'a door slam',
  'footsteps',
  'a glass clink',
  'glass breaking',
  'a metal clang',
  'a wooden knock',
  'a hand clap',
  'a finger snap',
  'a whoosh',
  'wind',
  'rain',
  'water pouring',
  'a splash',
  'a car engine',
  'a car horn',
  'a siren',
  'a dog barking',
  'a bird chirping',
  'a cat meowing',
  'a person speaking',
  'a crowd cheering',
  'laughter',
  'a cough',
  'music',
  'a piano note',
  'a guitar strum',
  'a drum hit',
  'a deep bass drop',
  'an electronic beep',
  'a notification chime',
  'a bell ringing',
  'a camera shutter',
  'paper rustling',
  'a zipper',
  'a pop',
  'a cork popping',
  'an explosion',
  'a gunshot',
  'static noise',
  'a phone vibrating',
  'silence',
]

/** Turns text and audio into unit vectors in one space: CLAP, or a stand-in in tests. */
export type Embedder = {
  text(texts: readonly string[]): Promise<number[][]>
  audio(clip: Float32Array): Promise<number[]>
}

/** The level of each 5 ms frame, in dB below full scale. */
const envelope = (mono: Float32Array, rate: number) => {
  const n = Math.max(1, Math.round(FRAME * rate))
  return Float32Array.from({ length: Math.ceil(mono.length / n) }, (_, f) => {
    let sum = 0
    const end = Math.min(mono.length, (f + 1) * n)
    for (let i = f * n; i < end; i++) sum += (mono[i] ?? 0) ** 2
    return 10 * Math.log10(sum / Math.max(1, end - f * n) + 1e-12)
  })
}

/**
 * One stroke per onset: from 5 ms before the level jumps (12 dB within 50 ms and 6 dB within
 * 10 ms, 20 dB over the recording's floor) until it has decayed 35 dB below its peak, the next
 * onset, or 2 s. Inside a stroke, the next onset needs the level to have fallen 15 dB below the
 * stroke's peak, or to jump 12 dB over it: a swell of noise wobbles, and is still one sound.
 */
export const strokesOf = (mono: Float32Array, rate: number) => {
  const env = envelope(mono, rate)
  const floor = [...env].sort((a, b) => a - b)[Math.floor(env.length * 0.1)] ?? -120
  const onsets: number[] = []
  let loudest = Number.NEGATIVE_INFINITY
  let fell = true
  for (let f = 1; f < env.length; f++) {
    const level = env[f] ?? -120
    let low = level
    for (let k = Math.max(0, f - 10); k < f; k++) low = Math.min(low, env[k] ?? -120)
    const last = onsets[onsets.length - 1]
    const recent = Math.min(env[f - 1] ?? -120, env[f - 2] ?? -120)
    if (
      level >= floor + 20 &&
      level - low >= 12 &&
      level - recent >= 6 &&
      (last === undefined || f - last >= 10) &&
      (fell || level >= loudest + 12)
    ) {
      onsets.push(f)
      loudest = level
      fell = false
    }
    loudest = Math.max(loudest, level)
    if (level <= loudest - 15) fell = true
  }
  const cap = Math.round(2 / FRAME)
  // A stroke ends before the next one starts, so takes that follow close on can both be picked.
  const starts = onsets.map((f) => Math.max(0, f * FRAME - 0.005))
  return onsets.map((f, i) => {
    const stop = Math.min(onsets[i + 1] ?? env.length, f + cap, env.length)
    let peak = f
    for (let k = f; k < stop; k++) if ((env[k] ?? -120) > (env[peak] ?? -120)) peak = k
    let end = peak
    while (end < stop - 1 && (env[end] ?? -120) > (env[peak] ?? -120) - 35) end++
    return {
      start: starts[i] ?? 0,
      end: Math.min(
        mono.length / rate,
        (end + 1) * FRAME,
        starts[i + 1] ?? Number.POSITIVE_INFINITY,
      ),
      level: env[peak] ?? -120,
    }
  })
}

/**
 * Plain windows of `win` seconds, half overlapping, covering the recording, each with its `level`:
 * its RMS in dBFS.
 */
export const windowsOf = (mono: Float32Array, rate: number, win: number) => {
  const seconds = mono.length / rate
  const w = Math.min(win, seconds)
  const out: { start: number; end: number; level: number }[] = []
  if (!(w > 0)) return out
  for (let s = 0; s + w <= seconds + 1e-9; s += w / 2) {
    const a = Math.round(s * rate)
    const b = Math.min(mono.length, Math.round((s + w) * rate))
    let sum = 0
    for (let i = a; i < b; i++) sum += (mono[i] ?? 0) ** 2
    out.push({ start: s, end: s + w, level: 10 * Math.log10(sum / Math.max(1, b - a) + 1e-12) })
  }
  return out
}

const r3 = (x: number) => Math.round(x * 1e3) / 1e3

/**
 * The loudest moment of `mono` between `start` and `end` seconds: `peak`, the centre of the
 * loudest window, to the millisecond, and `level`, that window's RMS in dBFS. The window is a
 * twentieth of the take, from 5 to 50 ms: sharp on a click, and on a whoosh the swell the ear
 * hears rather than one grain of its noise.
 */
export const loudestOf = (mono: Float32Array, rate: number, start: number, end: number) => {
  const a = Math.max(0, Math.round(start * rate))
  const b = Math.min(mono.length, Math.round(end * rate))
  const w = Math.max(1, Math.round(Math.min(0.05, Math.max(FRAME, (end - start) / 20)) * rate))
  const hop = Math.max(1, Math.round(0.001 * rate))
  // Running sums of squares, so each window is two lookups.
  const sums = new Float64Array(b - a + 1)
  for (let i = a; i < b; i++) sums[i - a + 1] = (sums[i - a] ?? 0) + (mono[i] ?? 0) ** 2
  const db = (energy: number, n: number) =>
    Math.round(10 * Math.log10(energy / n + 1e-12) * 10) / 10
  if (b - a <= w)
    return { peak: r3((a + b) / 2 / rate), level: db(sums[b - a] ?? 0, Math.max(1, b - a)) }
  let best = a
  let loudest = -1
  for (let i = a; i + w <= b; i += hop) {
    const energy = (sums[i - a + w] ?? 0) - (sums[i - a] ?? 0)
    if (energy > loudest) {
      loudest = energy
      best = i
    }
  }
  return { peak: r3((best + w / 2) / rate), level: db(loudest, w) }
}

export type ListenOptions = {
  top: number
  kind: 'event' | 'texture'
  win: number
  not: readonly string[]
}

/**
 * The best takes of `mono` for `query`, best first, none overlapping. A take's `cosine` is CLAP's
 * similarity to the query; `rank` is 1 when no other description (`not`, then the background)
 * fits it better; `z` is how far the query stands above those descriptions, in their spread.
 */
export const listen = async (
  mono: Float32Array,
  rate: number,
  query: string,
  o: ListenOptions,
  embed: Embedder,
  progress: (done: number, of: number) => void = () => {},
): Promise<{ trims: Trim[]; candidates: number; scored: number }> => {
  const samples = (c: { start: number; end: number }) =>
    mono.subarray(Math.round(c.start * rate), Math.round(c.end * rate))
  const found = o.kind === 'event' ? strokesOf(mono, rate) : windowsOf(mono, rate, o.win)
  // A near-silent stretch (under -60 dBFS) is never an answer.
  const all = found.filter((c) => samples(c).some((x) => Math.abs(x) >= 1e-3))
  if (all.length === 0)
    throw new Error(
      found.length > 0 || o.kind === 'texture'
        ? 'nothing in it is louder than -60 dBFS'
        : 'no onsets: for a bed or an ambience use --kind texture',
    )
  const scored = [...all].sort((a, b) => b.level - a.level).slice(0, MOST)
  const texts = [query, ...new Set([...o.not, ...BACKGROUND].filter((t) => t !== query))]
  const vectors = await embed.text(texts)
  const dot = (a: readonly number[], b: readonly number[]) =>
    a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0)
  const takes = []
  for (const [i, c] of scored.entries()) {
    const a = await embed.audio(samples(c))
    const cos = vectors.map((t) => dot(t, a))
    const own = cos[0] ?? 0
    const rest = cos.slice(1)
    const mean = rest.reduce((s, x) => s + x, 0) / rest.length
    const sd = Math.sqrt(rest.reduce((s, x) => s + (x - mean) ** 2, 0) / rest.length) || 1
    const best = cos.indexOf(Math.max(...cos))
    takes.push({
      ...c,
      cosine: own,
      rank: 1 + rest.filter((x) => x > own).length,
      z: (own - mean) / sd,
      heardAs: texts[best] ?? query,
    })
    progress(i + 1, scored.length)
  }
  takes.sort((a, b) => b.cosine - a.cosine)
  const picked: typeof takes = []
  for (const t of takes) {
    if (picked.length >= o.top) break
    if (picked.every((p) => t.end <= p.start || t.start >= p.end)) picked.push(t)
  }
  return {
    candidates: all.length,
    scored: scored.length,
    trims: picked.map((t, i) => ({
      id: `take-${i + 1}`,
      start: r3(t.start),
      end: r3(t.end),
      ...loudestOf(mono, rate, t.start, t.end),
      cosine: r3(t.cosine),
      rank: t.rank,
      z: Math.round(t.z * 100) / 100,
      heardAs: t.heardAs,
      kind: o.kind === 'event' ? 'stroke' : 'window',
    })),
  }
}

/** The few parts of transformers.js this tool calls. */
type Tensor = { data: Float32Array; dims: number[] }
type Model = (inputs: unknown) => Promise<Record<string, Tensor>>
type Loader<T> = { from_pretrained(id: string, o: Record<string, unknown>): Promise<T> }
type Transformers = {
  env: { cacheDir: string; version: string }
  AutoTokenizer: Loader<(t: readonly string[], o: Record<string, unknown>) => Promise<unknown>>
  AutoProcessor: Loader<(audio: Float32Array) => Promise<unknown>>
  ClapTextModelWithProjection: Loader<Model>
  ClapAudioModelWithProjection: Loader<Model>
}

/** CLAP on the CPU, from ~/.shaderera/models. */
const clap = async (): Promise<Embedder & { version: string; weights: Record<string, string> }> => {
  const { homedir } = await import('node:os')
  const { join } = await import('node:path')
  const { createReadStream, existsSync } = await import('node:fs')
  const { createHash } = await import('node:crypto')
  const t = (await import(TRANSFORMERS)) as Transformers
  t.env.cacheDir = join(homedir(), '.shaderera', 'models')
  const pinned = { revision: MODEL.revision }
  const tokenizer = await t.AutoTokenizer.from_pretrained(MODEL.id, pinned)
  const processor = await t.AutoProcessor.from_pretrained(MODEL.id, pinned)
  const textModel = await t.ClapTextModelWithProjection.from_pretrained(MODEL.id, {
    ...pinned,
    dtype: MODEL.dtype,
  })
  const audioModel = await t.ClapAudioModelWithProjection.from_pretrained(MODEL.id, {
    ...pinned,
    dtype: MODEL.dtype,
  })
  const weights: Record<string, string> = {}
  for (const file of WEIGHTS) {
    const path = join(t.env.cacheDir, MODEL.id, MODEL.revision, file)
    if (!existsSync(path)) throw new Error(`the weights are not at ${path} to stamp`)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
    weights[file] = hash.digest('hex')
  }
  const unit = (v: Float32Array) => {
    const n = Math.hypot(...v) || 1
    return Array.from(v, (x) => x / n)
  }
  return {
    version: t.env.version,
    weights,
    async text(texts) {
      const { text_embeds: e } = await textModel(
        await tokenizer(texts, { padding: true, truncation: true }),
      )
      const d = e?.dims[1] ?? 0
      return texts.map((_, i) => unit((e as Tensor).data.slice(i * d, (i + 1) * d)))
    },
    async audio(clip) {
      const { audio_embeds: e } = await audioModel(await processor(clip))
      return unit((e as Tensor).data)
    },
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
      top: { type: 'string', default: '5' },
      kind: { type: 'string', default: 'event' },
      win: { type: 'string', default: '2' },
      not: { type: 'string', multiple: true, default: [] },
      out: { type: 'string' },
    },
  })
  const [audio, query] = positionals
  if (!audio || !query)
    fail(
      'Usage: node tools/listen.ts <audio> "<description>" [--top 5] [--kind event|texture] [--win 2] [--not "<description>"]... [--out <file>]',
    )
  const inProject = (p: string) => {
    const rel = relative(process.cwd(), resolve(p)).replaceAll('\\', '/')
    if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel))
      fail(`${p} is outside this project: run from the project root, with the file inside it`)
    return rel
  }
  const path = inProject(audio as string)
  const out = inProject(values.out ?? path.replace(/(\.[^./]*)?$/, '.trims.json'))
  const o: ListenOptions = {
    top: Number(values.top),
    kind: values.kind as ListenOptions['kind'],
    win: Number(values.win),
    not: values.not as string[],
  }
  if (!(Number.isInteger(o.top) && o.top >= 1))
    fail(`--top ${values.top} must be a whole number from 1`)
  if (o.kind !== 'event' && o.kind !== 'texture')
    fail(`--kind ${values.kind} must be event or texture`)
  if (!(o.win > 0)) fail(`--win ${values.win} must be seconds over 0`)

  let raw = Buffer.alloc(0)
  try {
    raw = execFileSync(
      'ffmpeg',
      ['-v', 'error', '-i', path, '-f', 'f32le', '-ar', String(RATE), '-ac', '1', 'pipe:1'],
      { maxBuffer: Number.POSITIVE_INFINITY, stdio: ['ignore', 'pipe', 'pipe'] },
    )
  } catch (e) {
    const said = String((e as { stderr?: Buffer }).stderr ?? (e as Error).message).trim()
    fail(`${path}: ffmpeg could not decode it (${said.split('\n').pop()})`)
  }
  const mono = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
  console.error(`loading ${MODEL.from} (about 780 MB the first time, into ~/.shaderera/models)`)
  const model = await clap().catch((e: Error) =>
    fail(
      `CLAP did not load: ${e.message}. ${TRANSFORMERS} is installed with this plugin; run npm install if it is missing`,
    ),
  )
  let heard: Awaited<ReturnType<typeof listen>> = { trims: [], candidates: 0, scored: 0 }
  try {
    heard = await listen(mono, RATE, query as string, o, model, (done, of) => {
      if (done % 20 === 0 || done === of) console.error(`heard ${done} of ${of}`)
    })
  } catch (e) {
    fail(`${path}: ${(e as Error).message}`)
  }
  const bytes = new Uint8Array(readFileSync(path))
  const doc = {
    format: 'shaderera.analysis/1',
    kind: 'sound-trims',
    source: {
      path,
      bytes: bytes.length,
      sha256: await hex(bytes),
      seconds: Math.round((mono.length / RATE) * 1e6) / 1e6,
    },
    tool: {
      script: 'tools/listen.ts',
      model: { ...MODEL, weights: model.weights },
      transformers: model.version,
      ffmpeg: execFileSync('ffmpeg', ['-version']).toString().split('\n')[0]?.trim(),
    },
    params: { query, ...o, most: MOST, background: BACKGROUND },
    trims: heard.trims,
  }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`)
  for (const t of heard.trims)
    console.log(
      `${t.id}  ${t.start.toFixed(3)}–${t.end.toFixed(3)} s  peak +${Math.round((t.peak - t.start) * 1e3)} ms  ${t.level} dB  cosine ${t.cosine}  rank ${t.rank}  z ${t.z}${t.rank > 1 ? `  (fits "${t.heardAs}" better)` : ''}`,
    )
  console.log(
    `${out}: ${heard.trims.length} takes of "${query}" from ${heard.scored} of ${heard.candidates} ${o.kind === 'event' ? 'strokes' : 'windows'}`,
  )
}
