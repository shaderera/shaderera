// asset-provenance, through its command line in a project laid out the way `add` lays it out:
// records written as files arrive, then ASSETS.md and the description's credits made from them.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

const plugins = join(import.meta.dirname, '..')
const project = join(plugins, 'out', 'asset-provenance')
rmSync(project, { recursive: true, force: true })
const label = JSON.parse(
  readFileSync(join(plugins, 'asset-provenance', 'shaderera.item.json'), 'utf8'),
) as { files: string[] }
for (const f of label.files) {
  mkdirSync(dirname(join(project, f)), { recursive: true })
  cpSync(join(plugins, 'asset-provenance', f), join(project, f))
}

const put = (path: string, text: string) => {
  mkdirSync(dirname(join(project, path)), { recursive: true })
  writeFileSync(join(project, path), text)
}
const read = (path: string) => readFileSync(join(project, path), 'utf8')
const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, ['tools/provenance.ts', ...args], {
    cwd: project,
    encoding: 'utf8',
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

// sha256 of the ASCII text "wheat", from `printf wheat | sha256sum`.
const WHEAT = 'de6c334339ac3d3209cd340b0153f365b4211e30a75556870409b5a98b657a57'
// sha256 of the ASCII text "snow", from `printf snow | sha256sum`.
const SNOW = 'a746222f09d85605c52d4e636788d6ffdc274698b98b8c5f3244c06958683a69'

test('asset-provenance: record writes one record per file, with its hash', () => {
  put('assets/footage/wheat.mp4', 'wheat')
  const r = run(
    'record',
    'assets/footage/wheat.mp4',
    '--source',
    'https://www.pexels.com/video/golden-wheat-field-36080123/',
    '--licence',
    'Pexels License',
    '--author',
    'Sudheir Kumar',
    '--title',
    'Golden wheat field',
    '--segment',
    '0,7',
    '--fetched',
    '2026-10-16',
  )
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(JSON.parse(read('provenance/assets/footage/wheat.mp4.json')), {
    format: 'shaderera.provenance/1',
    file: 'assets/footage/wheat.mp4',
    sha256: WHEAT,
    source: 'https://www.pexels.com/video/golden-wheat-field-36080123/',
    licence: 'Pexels License',
    author: 'Sudheir Kumar',
    title: 'Golden wheat field',
    segment: [0, 7],
    credit: 'Golden wheat field, Sudheir Kumar · Pexels License',
    fetched: '2026-10-16',
  })
})

test('asset-provenance: credits writes its block in ASSETS.md and the description credits', () => {
  put('assets/art/snow.jpg', 'snow')
  assert.equal(
    run(
      'record',
      'assets/art/snow.jpg',
      '--source',
      'https://commons.wikimedia.org/wiki/File:Felis_catus-cat_on_snow.jpg',
      '--licence',
      'CC BY-SA 3.0',
      '--author',
      'Von.grzanka',
      '--title',
      'Cat on snow',
      '--fetched',
      '2026-10-16',
    ).code,
    0,
  )
  put('ASSETS.md', "# Assets\n\nThe voice is the person's own recording.\n")
  const r = run('credits')
  assert.equal(r.code, 0, r.err)
  assert.equal(
    read('ASSETS.md'),
    `# Assets

The voice is the person's own recording.

<!-- asset-provenance: made from provenance/ by \`node tools/provenance.ts credits\`; change the records, not this table -->
| File | Work | Source | Licence | sha256 |
|---|---|---|---|---|
| assets/art/snow.jpg | Cat on snow, Von.grzanka | <https://commons.wikimedia.org/wiki/File:Felis_catus-cat_on_snow.jpg> | CC BY-SA 3.0 | ${SNOW} |
| assets/footage/wheat.mp4 | Golden wheat field, Sudheir Kumar (source 0–7 s) | <https://www.pexels.com/video/golden-wheat-field-36080123/> | Pexels License | ${WHEAT} |
<!-- /asset-provenance -->
`,
  )
  assert.equal(
    read('out/credits.txt'),
    `Cat on snow, Von.grzanka · CC BY-SA 3.0 · https://commons.wikimedia.org/wiki/File:Felis_catus-cat_on_snow.jpg
Golden wheat field, Sudheir Kumar · Pexels License · https://www.pexels.com/video/golden-wheat-field-36080123/

Share-alike: adaptations in this video of works under CC BY-SA 3.0 (https://creativecommons.org/licenses/by-sa/3.0/) are shared under the same licence.
`,
  )

  // Again, after a hand edit above the block: the block is replaced in place, the rest is kept.
  writeFileSync(
    join(project, 'ASSETS.md'),
    read('ASSETS.md').replace('# Assets', '# Assets of the film'),
  )
  const before = read('ASSETS.md')
  assert.equal(run('credits').code, 0)
  assert.equal(read('ASSETS.md'), before)
})

test('asset-provenance: a record in another format is refused, by name', () => {
  put(
    'provenance/assets/old.jpg.json',
    '{ "format": "shaderera.provenance/0", "file": "assets/old.jpg" }',
  )
  const r = run('credits')
  rmSync(join(project, 'provenance/assets/old.jpg.json'))
  assert.equal(r.code, 2)
  assert.match(
    r.err,
    /provenance\/assets\/old\.jpg\.json is shaderera\.provenance\/0, not shaderera\.provenance\/1/,
  )
})
