import assert from 'node:assert/strict'
import { test } from 'node:test'

// docs/api.md: adding or removing an export is a visible change, made here on purpose.
test('the stable and experimental entries export exactly what docs/api.md lists', async () => {
  const keys = async (entry: string) => Object.keys(await import(entry)).sort()
  assert.deepEqual(await keys('./index.ts'), [
    'checkDeterminism',
    'diffJson',
    'diffPixels',
    'exportFrames',
    'flattenFrame',
    'frameAt',
    'frameTimes',
    'parseFps',
    'sha256',
  ])
  assert.deepEqual(await keys('./gpu.ts'), ['readBuffer', 'readTexture'])
  assert.deepEqual(await keys('./host.ts'), [
    'checkManifest',
    'dropFrame',
    'finalOnly',
    'formatShaderError',
    'fpsFraction',
    'frameCount',
    'framesOfTimecode',
    'fullDevice',
    'gainAt',
    'gpuCompositor',
    'layerInfo',
    'matte',
    'openSource',
    'over',
    'paramDefaults',
    'sampleClips',
    'sampleTimes',
    'seekable',
    'straight',
    'timecodeOf',
    'toSrt',
    'toVtt',
    'watchShaders',
    'windowCaptions',
    'withVariant',
    'yuvFits',
  ])
})
