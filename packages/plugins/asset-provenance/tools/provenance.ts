// Where each file from outside the project came from: one provenance record per file
// (shaderera.provenance/1), written when the file arrives, beside the project in
// provenance/<file path>.json. The film never reads them. Run from the project root.
//
//   node tools/provenance.ts record assets/footage/wheat.mp4 --source <page url> --licence "CC BY 4.0"
//        --author "Ann Lee" [--title "Wheat field"] [--segment 0,7] [--credit "<line on screen>"]
//        [--flag ai-generated] [--fetched 2026-10-16]
//   node tools/provenance.ts credits [--assets ASSETS.md] [--out out/credits.txt]
//   node tools/provenance.ts check [--dir assets]… [--json]
//
// credits writes a table of every record into ASSETS.md, between its markers (added at the end the
// first time; the rest of the file is left as written), and the credits for the video's
// description, with a share-alike note when a licence asks for one. check exits 1 and names every
// picture, clip or sound under the folders that has no record or changed since it was recorded,
// and every record whose file is gone. A refusal exits 2.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

export const FORMAT = 'shaderera.provenance/1'

export type Provenance = {
  format: typeof FORMAT
  /** The file's path in the project, with forward slashes. */
  file: string
  sha256: string
  /** The page it came from (not a CDN link), or who supplied or made it. */
  source: string
  licence: string
  author: string
  title?: string
  /** Seconds of the source that the file holds, for a trimmed clip. */
  segment?: [number, number]
  /** The line shown on screen; empty for a file that needs no credit (the person's own). */
  credit: string
  /** The day it was fetched, YYYY-MM-DD. */
  fetched: string
  /** Facts a person should know: `share-alike`, `ai-generated`, `overlay-cropped`, … */
  flags?: string[]
}

/** A refusal: the command line prints its message and exits 2. */
const fail = (message: string): never => {
  throw new Error(message)
}

/** A path inside the project, with forward slashes; anything outside it is refused. */
export const inProject = (path: string) => {
  const rel = relative(process.cwd(), resolve(path)).replaceAll('\\', '/')
  if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel))
    fail(`${path} is outside this project: run from the project root, with the file inside it`)
  return rel
}

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Where a file's record lives. */
export const recordPath = (file: string) => `provenance/${file}.json`

export const byFile = (a: { file: string }, b: { file: string }) =>
  a.file < b.file ? -1 : a.file > b.file ? 1 : 0
const isPage = (source: string) => /^https?:\/\//.test(source)
const workOf = (r: { title?: string | undefined; author: string }) =>
  [r.title, r.author].filter(Boolean).join(', ')

/** Share-alike by its flag, or by a licence that says so ("CC BY-SA 4.0", "…ShareAlike…"). */
export const shareAlike = (r: Provenance) =>
  r.flags?.includes('share-alike') === true || /\bSA\b|share-?alike/i.test(r.licence)

const record = (args: string[]) => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      source: { type: 'string' },
      licence: { type: 'string' },
      author: { type: 'string' },
      title: { type: 'string' },
      segment: { type: 'string' },
      credit: { type: 'string' },
      flag: { type: 'string', multiple: true },
      fetched: { type: 'string' },
    },
  })
  const [path] = positionals
  if (!path || !values.source || !values.licence || !values.author)
    fail(
      'Usage: node tools/provenance.ts record <file> --source <page> --licence <licence> --author <name>',
    )
  const file = inProject(path as string)
  if (!existsSync(file)) fail(`No file ${file}`)
  let segment: [number, number] | undefined
  if (values.segment) {
    const [a, b] = values.segment.split(',').map(Number)
    if (!(Number.isFinite(a) && Number.isFinite(b) && (b as number) > (a as number)))
      fail(`--segment ${values.segment} is not <from>,<to> in seconds`)
    segment = [a as number, b as number]
  }
  const fetched = values.fetched ?? new Date().toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fetched)) fail(`--fetched ${fetched} is not YYYY-MM-DD`)
  const author = values.author as string
  const rec: Provenance = {
    format: FORMAT,
    file,
    sha256: sha256(readFileSync(file)),
    source: values.source as string,
    licence: values.licence as string,
    author,
    ...(values.title ? { title: values.title } : {}),
    ...(segment ? { segment } : {}),
    credit: values.credit ?? `${workOf({ title: values.title, author })} · ${values.licence}`,
    fetched,
    ...(values.flag?.length ? { flags: values.flag } : {}),
  }
  const out = recordPath(file)
  const was = existsSync(out)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(rec, null, 2)}\n`)
  console.log(`${was ? 'updated' : 'recorded'} ${out}`)
}

/** Every record under provenance/, by file path. One that is not a record of this format is refused. */
export const readRecords = (root = 'provenance'): Provenance[] => {
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const path = `${root}/${f.replaceAll('\\', '/')}`
      let rec: Provenance | undefined
      try {
        rec = JSON.parse(readFileSync(path, 'utf8'))
      } catch {
        fail(`${path} is not JSON: fix it, or delete it and record its file again`)
      }
      if (rec?.format !== FORMAT)
        fail(`${path} is ${rec?.format ?? 'not a record'}, not ${FORMAT}: record its file again`)
      return rec as Provenance
    })
    .sort(byFile)
}

const BEGIN =
  '<!-- asset-provenance: made from provenance/ by `node tools/provenance.ts credits`; change the records, not this table -->'
const END = '<!-- /asset-provenance -->'

const cell = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ')
const seconds = (s: number) => String(Math.round(s * 100) / 100)

/** The table ASSETS.md carries between its markers. */
export const assetsBlock = (records: Provenance[]) =>
  [
    BEGIN,
    '| File | Work | Source | Licence | sha256 |',
    '|---|---|---|---|---|',
    ...records.map((r) => {
      const seg = r.segment ? ` (source ${seconds(r.segment[0])}–${seconds(r.segment[1])} s)` : ''
      const source = isPage(r.source) ? `<${r.source}>` : cell(r.source)
      const licence = r.flags?.length ? `${r.licence} (${r.flags.join(', ')})` : r.licence
      return `| ${cell(r.file)} | ${cell(workOf(r) + seg)} | ${source} | ${cell(licence)} | ${r.sha256} |`
    }),
    END,
  ].join('\n')

/** text with its block replaced, or the block added at the end after a blank line. */
export const withBlock = (text: string, block: string) => {
  const a = text.indexOf(BEGIN)
  const b = text.indexOf(END)
  if (a >= 0 && b > a) return text.slice(0, a) + block + text.slice(b + END.length)
  if (a >= 0 || b >= 0)
    fail('ASSETS.md has one asset-provenance marker without the other: fix it by hand')
  const gap = text === '' || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n'
  return `${text}${gap}${block}\n`
}

/** A Creative Commons licence's deed, from its short name ("CC BY-SA 3.0"), or undefined. */
export const deed = (licence: string) => {
  const m = /^CC (BY(?:-NC)?(?:-SA|-ND)?) (\d\.\d)$/i.exec(licence.trim())
  return m
    ? `https://creativecommons.org/licenses/${(m[1] as string).toLowerCase()}/${m[2]}/`
    : undefined
}

/**
 * The description's credits: one line a work (files cut from the same work share it; none for an
 * empty credit), then a note for each share-alike licence.
 */
export const descriptionCredits = (records: Provenance[]) => {
  const lines = [
    ...new Set(
      records
        .filter((r) => r.credit !== '')
        .map((r) => (isPage(r.source) ? `${r.credit} · ${r.source}` : r.credit)),
    ),
  ]
  const notes = [...new Set(records.filter(shareAlike).map((r) => r.licence))].sort().map((l) => {
    const url = deed(l)
    return `Share-alike: adaptations in this video of works under ${l}${url ? ` (${url})` : ''} are shared under the same licence.`
  })
  return `${[...lines, ...(notes.length ? ['', ...notes] : [])].join('\n')}\n`
}

const credits = (args: string[]) => {
  const { values } = parseArgs({
    args,
    options: {
      assets: { type: 'string', default: 'ASSETS.md' },
      out: { type: 'string', default: 'out/credits.txt' },
    },
  })
  const records = readRecords()
  const assets = values.assets as string
  const text = existsSync(assets) ? readFileSync(assets, 'utf8') : ''
  writeFileSync(assets, withBlock(text, assetsBlock(records)))
  mkdirSync(dirname(values.out as string), { recursive: true })
  writeFileSync(values.out as string, descriptionCredits(records))
  console.log(`${records.length} records: ${assets}, ${values.out}`)
}

/** Pictures, footage and sound: the files check expects a record for. */
const MEDIA =
  /\.(jpe?g|png|webp|gif|tiff?|avif|bmp|svg|exr|hdr|mp4|mov|webm|mkv|m4v|avi|wav|mp3|m4a|aac|flac|ogg|opus|aiff?)$/i

export type Finding = {
  code: 'no-record' | 'changed' | 'no-file' | 'error'
  severity: 'error'
  message: string
  file?: string
}

/** Every media file under the folders without a record, changed since its record, or gone. */
export const checkRecords = (records: Provenance[], folders: string[]): Finding[] => {
  const recorded = new Map(records.map((r) => [r.file, r]))
  const media = folders
    .map(inProject)
    .filter((d) => existsSync(d))
    .flatMap((d) =>
      readdirSync(d, { recursive: true, encoding: 'utf8' }).map(
        (f) => `${d}/${f.replaceAll('\\', '/')}`,
      ),
    )
    .filter((f) => MEDIA.test(f))
  const found: Finding[] = []
  for (const file of media) {
    const r = recorded.get(file)
    if (!r)
      found.push({ code: 'no-record', severity: 'error', file, message: `${file} has no record` })
    else if (sha256(readFileSync(file)) !== r.sha256)
      found.push({
        code: 'changed',
        severity: 'error',
        file,
        message: `${file} changed since it was recorded: record it again`,
      })
  }
  for (const r of records)
    if (!existsSync(r.file))
      found.push({
        code: 'no-file',
        severity: 'error',
        file: r.file,
        message: `${r.file} is recorded but gone: delete ${recordPath(r.file)}`,
      })
  return found.sort((a, b) => byFile({ file: a.file ?? '' }, { file: b.file ?? '' }))
}

/** check's result: printed as messages, or as `{ ok, exitCode, findings }` with --json. */
const report = (json: boolean, exitCode: number, findings: Finding[]) => {
  if (json) console.log(JSON.stringify({ ok: exitCode === 0, exitCode, findings }))
  else
    for (const f of findings.length ? findings : [{ message: 'every file has its record' }])
      (exitCode === 2 ? console.error : console.log)(f.message)
  process.exitCode = exitCode
}

const check = (args: string[]) => {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: 'string', multiple: true, default: ['assets'] },
      json: { type: 'boolean', default: false },
    },
  })
  const json = values.json as boolean
  try {
    const findings = checkRecords(readRecords(), values.dir as string[])
    report(json, findings.length ? 1 : 0, findings)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    report(json, 2, [{ code: 'error', severity: 'error', message }])
  }
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2)
  try {
    if (command === 'record') record(rest)
    else if (command === 'credits') credits(rest)
    else if (command === 'check') check(rest)
    else fail('Usage: node tools/provenance.ts record <file> … | credits | check')
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = 2
  }
}
