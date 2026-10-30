import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { checkManifest } from '@shaderera/core/host'

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
const schema = read('../../shaderera.schema.json')

// A manifest with every key: what checkManifest accepts is what the schema describes.
const full = {
  $schema: './node_modules/shaderera/shaderera.schema.json',
  shaderera: 'manifest/1',
  entry: './src/composition.ts',
  fps: '24000/1001',
  duration: 10.01,
  width: 1920,
  height: 1080,
  params: { type: 'object' },
  seed: 1,
  sequential: 8,
  host: 'browser',
  dom: './src/dom.tsx',
  domScale: 2,
  stamp: true,
  variants: {
    tv: {
      label: 'TV',
      width: 1280,
      height: 720,
      duration: 6,
      fps: 25,
      params: {},
      preroll: { seconds: 10, fill: 'source' },
      timecode: '10:00:00:00',
      textless: true,
    },
  },
  preroll: { seconds: 2 },
  timecode: '01:00:00:00',
  textless: true,
  bakes: { beauty: { command: 'make', inputs: ['.'], dir: 'out/b', frames: 'b.####.jpg' } },
  requires: { shaderera: '^0.1.5', extensions: { '@x/one': '^1.0.0' } },
  hdr10: {
    graphicsWhite: 203,
    mastering: { peak: 1000, min: 0.005, primaries: 'p3-d65' },
    dither: 'tpdf',
  },
}

test('shaderera.schema.json describes exactly the keys checkManifest reads', () => {
  checkManifest(full)
  const keys = (o: object) => Object.keys(o).sort()
  assert.deepEqual(keys(schema.properties), keys(full))
  assert.deepEqual(keys(schema.definitions.variant.properties), keys(full.variants.tv))
  assert.deepEqual(keys(schema.definitions.bake.properties), keys(full.bakes.beauty))
  assert.deepEqual(keys(schema.properties.requires.properties), keys(full.requires))
  assert.deepEqual(keys(schema.properties.hdr10.properties), keys(full.hdr10))
  assert.deepEqual(
    keys(schema.properties.hdr10.properties.mastering.properties),
    keys(full.hdr10.mastering),
  )
  assert.deepEqual(schema.required.sort(), ['duration', 'entry', 'fps', 'height', 'width'])
  assert.equal(schema.properties.shaderera.const, 'manifest/1')
})

test('a new project points its $schema at the file the shaderera package ships', () => {
  const project = read('../../../../packages/create-shaderera/project/shaderera.json')
  assert.equal(project.$schema, './node_modules/shaderera/shaderera.schema.json')
  assert.equal(project.shaderera, 'manifest/1')
  checkManifest(project)
  assert.ok(read('../../package.json').files.includes('shaderera.schema.json'))
})
