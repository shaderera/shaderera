// asset-provenance's preview data: four small files made here (a picture, two clips and a sound)
// in a project of their own, each recorded by the plugin's tools/provenance.ts, then its credits
// and its check. The sources are example.org pages: placeholders, so no real work is credited
// with a file it never was. The preview reads audio/asset-provenance/preview.json.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The previews project, where the composition reads its audio/.
const root = join(import.meta.dirname, '..', '..', 'previews')
const project = join(root, 'audio', 'asset-provenance')
rmSync(project, { recursive: true, force: true })
const tool = join(root, 'tools', 'provenance.ts')
const run = (...args: string[]) =>
  execFileSync(process.execPath, [tool, ...args], { cwd: project, encoding: 'utf8' })

const FILES = [
  {
    file: 'assets/art/seated-cat.jpg',
    title: 'Seated cat, bronze',
    author: 'a museum',
    licence: 'CC0 1.0',
  },
  {
    file: 'assets/footage/wheat-field.mp4',
    title: 'Wheat field',
    author: 'a filmmaker',
    licence: 'CC BY 4.0',
    segment: '2,9',
  },
  {
    file: 'assets/footage/street-cat.mp4',
    title: 'Street cat',
    author: 'a photographer',
    licence: 'CC BY-SA 3.0',
    segment: '0,4.5',
  },
  {
    file: 'assets/sound/rain.wav',
    title: 'Rain on a roof',
    author: 'a sound recordist',
    licence: 'CC BY 4.0',
  },
]

for (const [i, f] of FILES.entries()) {
  mkdirSync(join(project, f.file, '..'), { recursive: true })
  writeFileSync(join(project, f.file), `preview file ${i}: ${f.title}`)
  run(
    'record',
    f.file,
    '--source',
    `https://example.org/${f.file.split('/').pop()}`,
    '--licence',
    f.licence,
    '--author',
    f.author,
    '--title',
    f.title,
    '--fetched',
    '2026-10-16',
    ...(f.segment ? ['--segment', f.segment] : []),
  )
}
run('credits')
const check = JSON.parse(run('check', '--json'))
const records = FILES.map((f) =>
  JSON.parse(readFileSync(join(project, 'provenance', `${f.file}.json`), 'utf8')),
)
const credits = readFileSync(join(project, 'out', 'credits.txt'), 'utf8')
writeFileSync(
  join(project, 'preview.json'),
  `${JSON.stringify({ records, credits, check }, null, 2)}\n`,
)
console.log(`asset-provenance preview: ${records.length} records, check exit ${check.exitCode}`)
