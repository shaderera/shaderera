// Where each file from outside the project came from: one provenance record per file
// (shaderera.provenance/1), written when the file arrives, beside the project in
// provenance/<file path>.json. The film never reads them. Run from the project root.
//
//   node tools/provenance.ts record assets/footage/wheat.mp4 --source <page url> --licence "CC BY 4.0"
//        --author "Ann Lee" [--title "Wheat field"] [--segment 0,7] [--credit "<line on screen>"]
//        [--flag ai-generated] [--fetched 2026-10-16]
//   node tools/provenance.ts credits [--assets ASSETS.md] [--out out/credits.txt]
//
// credits writes a table of every record into ASSETS.md, between its markers (added at the end the
// first time; the rest of the file is left as written), and the credits for the video's
// description, with a share-alike note when a licence asks for one.

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
  /** The line shown on screen. */
  credit: string
  /** The day it was fetched, YYYY-MM-DD. */
  fetched: string
  /** Facts a person should know: `ai-generated`, `overlay-cropped`, … */
  flags?: string[]
}

const fail = (message: string): never => {
  console.error(message)
  process.exit(2)
}

/** A path inside the project, with forward slashes; anything outside it is refused. */
const inProject = (path: string) => {
  const rel = relative(process.cwd(), resolve(path)).replaceAll('\\', '/')
  if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel))
    fail(`${path} is outside this project: run from the project root, with the file inside it`)
  return rel
}

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Where a file's record lives. */
export const recordPath = (file: string) => `provenance/${file}.json`

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
  const work = [values.title, values.author].filter(Boolean).join(', ')
  const rec: Provenance = {
    format: FORMAT,
    file,
    sha256: sha256(readFileSync(file)),
    source: values.source as string,
    licence: values.licence as string,
    author: values.author as string,
    ...(values.title ? { title: values.title } : {}),
    ...(segment ? { segment } : {}),
    credit: values.credit ?? `${work} · ${values.licence}`,
    fetched,
    ...(values.flag?.length ? { flags: values.flag } : {}),
  }
  const out = recordPath(file)
  const was = existsSync(out)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(rec, null, 2)}\n`)
  console.log(`${was ? 'updated' : 'recorded'} ${out}`)
}

/** Every record under provenance/, by file path. A record in another format is refused. */
export const readRecords = (root = 'provenance'): Provenance[] => {
  if (!existsSync(root)) return []
  const records = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const path = `${root}/${f.replaceAll('\\', '/')}`
      const rec = JSON.parse(readFileSync(path, 'utf8')) as Provenance
      if (rec.format !== FORMAT)
        fail(`${path} is ${rec.format ?? 'not a record'}, not ${FORMAT}: record its file again`)
      return rec
    })
  return records.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
}

const BEGIN =
  '<!-- asset-provenance: made from provenance/ by `node tools/provenance.ts credits`; change the records, not this table -->'
const END = '<!-- /asset-provenance -->'

const cell = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ')
const link = (source: string) => (/^https?:\/\//.test(source) ? `<${source}>` : cell(source))
const seconds = (s: number) => String(Math.round(s * 100) / 100)

/** The table ASSETS.md carries between its markers. */
export const assetsBlock = (records: Provenance[]) =>
  [
    BEGIN,
    '| File | Work | Source | Licence | sha256 |',
    '|---|---|---|---|---|',
    ...records.map((r) => {
      const work = [r.title, r.author].filter(Boolean).join(', ')
      const seg = r.segment ? ` (source ${seconds(r.segment[0])}–${seconds(r.segment[1])} s)` : ''
      return `| ${cell(r.file)} | ${cell(work + seg)} | ${link(r.source)} | ${cell(r.licence)} | ${r.sha256} |`
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

/** The description's credits: one line a file, then a note for each share-alike licence. */
export const descriptionCredits = (records: Provenance[]) => {
  const lines = records.map((r) =>
    /^https?:\/\//.test(r.source) ? `${r.credit} · ${r.source}` : r.credit,
  )
  const shareAlike = [...new Set(records.map((r) => r.licence).filter((l) => /\bSA\b/.test(l)))]
    .sort()
    .map((l) => {
      const url = deed(l)
      return `Share-alike: adaptations in this video of works under ${l}${url ? ` (${url})` : ''} are shared under the same licence.`
    })
  return `${[...lines, ...(shareAlike.length ? ['', ...shareAlike] : [])].join('\n')}\n`
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

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'record') record(rest)
  else if (command === 'credits') credits(rest)
  else fail('Usage: node tools/provenance.ts record <file> … | credits')
}
