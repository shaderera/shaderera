// Bakes sound made in code into an .m4a the film plays as a file clip: imports a module, calls its
// export with the film's duration and seed from shaderera.json, refuses NaN or Inf, and encodes the
// samples as they are (f32le into ffmpeg's AAC; no gain, no normalising). Beside the file it writes
// a stamp, which src/audio/baked.ts checks in `open`, so a film never plays a bed its code no
// longer makes. Run from the project root, with every path inside the project. Needs ffmpeg on PATH.
//
//   node tools/pcm-bake.ts src/music/bed.ts --out assets/music/bed.m4a
//     [--export default] [--inputs data/parts.json,data/hits.json] [--bitrate 192k]
//
// --export  the module's export to call, (duration, seed) => Pcm or a Promise of one; `default`
//           unless named
// --inputs  project files the module reads itself (fs), comma-separated: their hashes go in the
//           stamp. Every project file the module imports, at any depth, is stamped on its own.
// --bitrate the AAC bitrate (`-b:a`); ffmpeg's own default when left out
//
// Writes <out> and <out without .m4a>.stamp.json: a shaderera.analysis/1 artifact of kind
// `pcm-bake` whose source is the module, with the sha256 of every project file it imported, of
// the inputs and of the output, the seed and the duration. Prints the peak and the synthesis time.

import { sha256 } from '@shaderera/core'

/** The stamp beside a baked file: `assets/music/bed.m4a` → `assets/music/bed.stamp.json`. */
export const stampOf = (out: string) => out.replace(/\.m4a$/i, '.stamp.json')

/**
 * The samples interleaved for ffmpeg, and their peak; throws on anything ffmpeg would take but a
 * film should not: no channels, more than two, unequal lengths, a bad rate, NaN or Inf.
 */
export const interleave = (pcm: { sampleRate: number; channels: readonly Float32Array[] }) => {
  const { sampleRate, channels } = pcm
  if (!(Number.isInteger(sampleRate) && sampleRate > 0))
    throw new Error(`sampleRate ${sampleRate} must be a whole number of hertz`)
  if (channels.length < 1 || channels.length > 2)
    throw new Error(`${channels.length} channels: give one or two`)
  const frames = channels[0]?.length ?? 0
  if (channels.some((c) => c.length !== frames))
    throw new Error(`the channels differ in length: ${channels.map((c) => c.length).join(', ')}`)
  const n = channels.length
  const out = new Float32Array(frames * n)
  let peak = 0
  for (let c = 0; c < n; c++) {
    const ch = channels[c] as Float32Array
    for (let i = 0; i < frames; i++) {
      const v = ch[i] as number
      if (!Number.isFinite(v))
        throw new Error(`channel ${c}, sample ${i} (${(i / sampleRate).toFixed(3)} s) is ${v}`)
      out[i * n + c] = v
      const a = Math.abs(v)
      if (a > peak) peak = a
    }
  }
  return { data: out, frames, peak }
}

if (import.meta.main) {
  const { execFileSync, spawnSync } = await import('node:child_process')
  const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs')
  const { registerHooks } = await import('node:module')
  const { dirname, isAbsolute, relative, resolve } = await import('node:path')
  const { fileURLToPath, pathToFileURL } = await import('node:url')
  const { parseArgs } = await import('node:util')
  const fail = (message: string): never => {
    console.error(message)
    process.exit(2)
  }
  const usage =
    'Usage: node tools/pcm-bake.ts <module> --out <file.m4a> [--export name] [--inputs a,b] [--bitrate 192k]'
  const parse = () => {
    try {
      return parseArgs({
        allowPositionals: true,
        options: {
          out: { type: 'string' },
          export: { type: 'string', default: 'default' },
          inputs: { type: 'string', default: '' },
          bitrate: { type: 'string' },
          help: { type: 'boolean' },
        },
      })
    } catch (e) {
      return fail(`${(e as Error).message}\n${usage}`)
    }
  }
  const { values, positionals } = parse()
  if (values.help) {
    console.log(usage)
    process.exit(0)
  }
  const [moduleArg] = positionals
  if (!moduleArg || !values.out) fail(usage)
  if (!values.out?.toLowerCase().endsWith('.m4a'))
    fail(`--out ${values.out} must end in .m4a\n${usage}`)
  const inProject = (p: string) => {
    const rel = relative(process.cwd(), resolve(p)).replaceAll('\\', '/')
    if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel))
      fail(`${p} is outside this project: run from the project root, with the file inside it`)
    return rel
  }
  const existing = (p: string) => {
    const rel = inProject(p)
    if (!existsSync(rel)) fail(`${p} not found`)
    return rel
  }
  const modulePath = existing(moduleArg as string)
  const out = inProject(values.out as string)
  const inputs = (values.inputs as string).split(',').filter(Boolean).map(existing)
  const name = values.export as string
  if (spawnSync('ffmpeg', ['-version']).status !== 0) fail('ffmpeg is not on PATH')

  const manifest = JSON.parse(readFileSync('shaderera.json', 'utf8')) as {
    duration: number
    seed?: number
  }
  const seed = manifest.seed ?? 0
  const { duration } = manifest
  const fileOf = async (path: string) => {
    const bytes = new Uint8Array(readFileSync(path))
    return { path, bytes: bytes.length, sha256: await sha256(bytes) }
  }
  // Hashed before the import, so a file changed while the samples are made is not stamped as read.
  const src = await fileOf(modulePath)
  const read = await Promise.all(inputs.map(fileOf))

  // Every project file the import loads, at any depth and outside node_modules, kept as it loads:
  // a shared synth or a plugin the module builds on is checked like the module itself.
  const imported = new Map<string, Uint8Array>()
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context)
      if (url.startsWith('file:')) {
        const rel = relative(process.cwd(), fileURLToPath(url)).replaceAll('\\', '/')
        const inside = !(rel.startsWith('../') || isAbsolute(rel))
        if (inside && !rel.split('/').includes('node_modules') && rel !== modulePath)
          imported.set(rel, new Uint8Array(readFileSync(rel)))
      }
      return result
    },
  })

  const started = performance.now()
  const mod = (await import(pathToFileURL(resolve(modulePath)).href)) as Record<string, unknown>
  const make = mod[name]
  if (typeof make !== 'function')
    fail(`${modulePath} has no function export \`${name}\`: name it with --export`)
  let baked: ReturnType<typeof interleave> | undefined
  let sampleRate = 0
  let channels = 0
  try {
    const pcm = await (make as (d: number, s: number) => unknown)(duration, seed)
    const p = pcm as { sampleRate: number; channels: readonly Float32Array[] }
    if (!p || !Array.isArray(p.channels))
      throw new Error('it did not return a Pcm { sampleRate, channels }')
    baked = interleave(p)
    sampleRate = p.sampleRate
    channels = p.channels.length
  } catch (e) {
    fail(
      `${modulePath} \`${name}\`(${duration}, ${seed}): ${(e as Error).message}; nothing written`,
    )
  }
  const { data, frames, peak } = baked as ReturnType<typeof interleave>
  const made = performance.now()

  mkdirSync(dirname(out), { recursive: true })
  const bitrate = values.bitrate ? ['-b:a', values.bitrate] : []
  execFileSync(
    'ffmpeg',
    [
      ...['-v', 'error', '-y', '-f', 'f32le', '-ar', String(sampleRate), '-ac', String(channels)],
      ...['-i', 'pipe:0', '-c:a', 'aac', ...bitrate, out],
    ],
    { input: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) },
  )
  const command = [
    'node tools/pcm-bake.ts',
    modulePath,
    `--out ${out}`,
    ...(name === 'default' ? [] : [`--export ${name}`]),
    ...(inputs.length ? [`--inputs ${inputs.join(',')}`] : []),
    ...(values.bitrate ? [`--bitrate ${values.bitrate}`] : []),
  ].join(' ')
  const seconds = frames / sampleRate
  const doc = {
    format: 'shaderera.analysis/1',
    kind: 'pcm-bake',
    source: { path: src.path, bytes: src.bytes, sha256: src.sha256 },
    tool: {
      script: 'tools/pcm-bake.ts',
      ffmpeg: execFileSync('ffmpeg', ['-version']).toString().split('\n')[0]?.trim(),
    },
    params: { export: name, seed, duration, bitrate: values.bitrate ?? null },
    command,
    imports: await Promise.all(
      [...imported]
        .filter(([path]) => !inputs.includes(path))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(async ([path, bytes]) => ({ path, bytes: bytes.length, sha256: await sha256(bytes) })),
    ),
    inputs: read,
    output: { ...(await fileOf(out)), seconds, sampleRate, channels, peak },
  }
  const stamp = stampOf(out)
  writeFileSync(stamp, `${JSON.stringify(doc, null, 2)}\n`)
  const db = peak > 0 ? `${(20 * Math.log10(peak)).toFixed(1)} dBFS` : 'silence'
  console.log(
    `${out}: ${seconds.toFixed(2)} s, ${channels} ch at ${sampleRate} Hz, peak ${peak.toFixed(4)} (${db})${peak > 1 ? ', over 1: it will clip' : ''}; synthesis ${((made - started) / 1000).toFixed(1)} s; ${stamp}`,
  )
}
