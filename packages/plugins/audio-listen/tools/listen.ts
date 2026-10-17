// Hears a recording with Earshot and keeps the takes that match a description as trims: runs
// Earshot's `find`, or reads its answer saved from Earshot's MCP server, measures each take's peak
// (the loudest 5 ms) with ffmpeg, and writes a shaderera.analysis/1 sound-trims artifact stamped
// with the recording's sha256, which src/audio/trims.ts reads. Run from the project root, with the
// recording inside it. Needs ffmpeg on PATH, and Earshot (https://github.com/Leonxlnx/earshot, the
// person's own install) unless --answer is given.
//
//   node tools/listen.ts audio/keys.wav "a single mechanical key press" [--top 5] [--kind auto]
//     [--python <Earshot's python>] [--out audio/keys.trims.json]
//   node tools/listen.ts audio/keys.wav --answer out/keys.find.json
//
// --top     how many takes, best first
// --kind    event: onset-based takes only (hits, clicks, steps); texture: plain stretches (beds);
//           auto: Earshot reads the description and scores both
// --python  the Python Earshot is installed in (default: $EARSHOT_PYTHON, else python)
// --answer  Earshot's find answer as JSON (the MCP tool with full output, or the CLI's --out),
//           instead of running Earshot here
// --out     the artifact (default: beside the recording, <name>.trims.json)

import type { Trim } from '../src/audio/trims.ts'

/** What Earshot's `find` answers, as far as this tool reads it. */
export type Answer = {
  summary?: string
  error?: string
  path?: string
  query?: string
  segments?: {
    start: number
    end: number
    z: number
    verdict: string
    kind: string
    cut?: string
  }[]
}

const RATE = 48000
/** The loudness envelope's window and hop, in seconds. */
const WINDOW = 0.005
const HOP = 0.001

/** The centre of the loudest 5 ms of `mono` between `start` and `end` seconds, to the millisecond. */
export const peakOf = (mono: Float32Array, rate: number, start: number, end: number) => {
  const a = Math.max(0, Math.round(start * rate))
  const b = Math.min(mono.length, Math.round(end * rate))
  const w = Math.max(1, Math.round(WINDOW * rate))
  const hop = Math.max(1, Math.round(HOP * rate))
  if (b - a <= w) return Math.round(((a + b) / 2 / rate) * 1e3) / 1e3
  // Running sums of squares, so each window is two lookups.
  const sums = new Float64Array(b - a + 1)
  for (let i = a; i < b; i++) sums[i - a + 1] = (sums[i - a] ?? 0) + (mono[i] ?? 0) ** 2
  let best = a
  let loudest = -1
  for (let i = a; i + w <= b; i += hop) {
    const energy = (sums[i - a + w] ?? 0) - (sums[i - a] ?? 0)
    if (energy > loudest) {
      loudest = energy
      best = i
    }
  }
  return Math.round(((best + w / 2) / rate) * 1e3) / 1e3
}

/** Earshot's segments as trims, best first, each with its peak measured on `mono`. */
export const trimsOf = (answer: Answer, mono: Float32Array, rate: number): Trim[] => {
  if (answer.error) throw new Error(`Earshot could not answer: ${answer.error}`)
  if (!Array.isArray(answer.segments))
    throw new Error("this is not an answer of Earshot's find: it has no segments")
  return answer.segments.map((s, i) => ({
    id: `take-${i + 1}`,
    start: s.start,
    end: s.end,
    peak: peakOf(mono, rate, s.start, s.end),
    z: s.z,
    verdict: s.verdict,
    kind: s.kind,
    cut: s.cut ?? '',
  }))
}

const hex = async (bytes: Uint8Array) => {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

if (import.meta.main) {
  const { execFileSync, spawnSync } = await import('node:child_process')
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
      kind: { type: 'string', default: 'auto' },
      python: { type: 'string', default: process.env.EARSHOT_PYTHON || 'python' },
      answer: { type: 'string' },
      out: { type: 'string' },
    },
  })
  const [audio, description] = positionals
  if (!audio || (!description && !values.answer))
    fail(
      'Usage: node tools/listen.ts <audio> "<description>" [--top 5] [--kind auto|event|texture] [--python <path>] [--out <file>]\n' +
        '       node tools/listen.ts <audio> --answer <earshot-find.json> [--out <file>]',
    )
  const inProject = (p: string) => {
    const rel = relative(process.cwd(), resolve(p)).replaceAll('\\', '/')
    if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel))
      fail(`${p} is outside this project: run from the project root, with the file inside it`)
    return rel
  }
  const path = inProject(audio as string)
  const out = inProject(values.out ?? path.replace(/(\.[^./]*)?$/, '.trims.json'))
  const top = Number(values.top)
  if (!(Number.isInteger(top) && top >= 1))
    fail(`--top ${values.top} must be a whole number from 1`)
  if (!['auto', 'event', 'texture'].includes(values.kind as string))
    fail(`--kind ${values.kind} must be auto, event or texture`)

  const python = values.python as string
  const missing = `Earshot did not run with ${python}. Install it (https://github.com/Leonxlnx/earshot) and pass its Python with --python or EARSHOT_PYTHON, or save the answer of Earshot's MCP find tool and pass it with --answer`
  let answer: Answer
  let tool: Record<string, unknown>
  let params: { query: string } & Record<string, unknown>
  if (values.answer) {
    answer = JSON.parse(readFileSync(values.answer, 'utf8')) as Answer
    const same = (a: string, b: string) =>
      process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
    if (answer.path && !same(resolve(answer.path), resolve(path)))
      fail(`${values.answer} is Earshot's answer for ${answer.path}, not ${path}`)
    if (description && answer.query !== description)
      fail(`${values.answer} answers "${answer.query}", not "${description}"`)
    tool = { script: 'tools/listen.ts', analyser: 'earshot find', answer: values.answer }
    params = { query: answer.query ?? '' }
  } else {
    const run = spawnSync(
      python,
      [
        '-m',
        'earshot',
        'find',
        path,
        description as string,
        '--top',
        String(top),
        '--kind',
        values.kind as string,
        '--json',
      ],
      { encoding: 'utf8', maxBuffer: Number.POSITIVE_INFINITY },
    )
    if (run.error) fail(`${missing}. (${run.error.message})`)
    try {
      answer = JSON.parse(run.stdout) as Answer
    } catch {
      answer = fail(`${missing}. It said: ${run.stderr.trim().split('\n').pop() ?? ''}`)
    }
    const version = spawnSync(python, ['-c', 'import earshot; print(earshot.__version__)'], {
      encoding: 'utf8',
    }).stdout.trim()
    tool = { script: 'tools/listen.ts', analyser: 'earshot find', earshot: version }
    params = { query: description as string, top, kind: values.kind }
  }

  const raw = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', path, '-f', 'f32le', '-ar', String(RATE), '-ac', '1', 'pipe:1'],
    { maxBuffer: Number.POSITIVE_INFINITY },
  )
  const mono = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
  let trims: Trim[] = []
  try {
    trims = trimsOf(answer, mono, RATE)
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
      ...tool,
      ffmpeg: execFileSync('ffmpeg', ['-version']).toString().split('\n')[0]?.trim(),
    },
    params,
    heard: answer.summary ?? '',
    trims,
  }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`)
  console.log(doc.heard)
  for (const t of trims)
    console.log(
      `${t.id}  ${t.start.toFixed(3)}–${t.end.toFixed(3)} s  peak ${t.peak.toFixed(3)} (+${Math.round((t.peak - t.start) * 1e3)} ms)  z ${t.z}  ${t.verdict}${t.cut ? `  ${t.cut}` : ''}`,
    )
  console.log(`${out}: ${trims.length} takes of "${params.query}"`)
}
