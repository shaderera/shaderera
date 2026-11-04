// Makes the audio-pcm-bake preview's sound in code, with the item's own tool: copies preview/bed.ts
// to audio/pcm-bed.ts, writes the chord it reads as audio/pcm-bed.json, and bakes it as a film
// would, which writes audio/pcm-bed.m4a and audio/pcm-bed.stamp.json. The baked file is decoded to
// audio/pcm-bed.wav for the picture's waveform. Run after scripts/assemble.ts (scripts/render.ts
// does both).
//   node packages/plugins/audio-pcm-bake/preview/make.ts

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** A wide A chord whose every pitch is a whole number of cycles in 6 s. */
const HZ = [110, 165, 220, 277.5, 330, 440]

// The previews project, where the composition reads its audio/.
const root = join(import.meta.dirname, '..', '..', 'previews')
mkdirSync(join(root, 'audio'), { recursive: true })
copyFileSync(join(import.meta.dirname, 'bed.ts'), join(root, 'audio', 'pcm-bed.ts'))
writeFileSync(join(root, 'audio', 'pcm-bed.json'), `${JSON.stringify({ hz: HZ })}\n`)
// The item, as a film would run it.
execFileSync(
  process.execPath,
  [
    join(root, 'tools', 'pcm-bake.ts'),
    ...['audio/pcm-bed.ts', '--out', 'audio/pcm-bed.m4a'],
    ...['--inputs', 'audio/pcm-bed.json', '--bitrate', '192k'],
  ],
  { cwd: root, stdio: 'inherit' },
)
execFileSync(
  'ffmpeg',
  ['-v', 'error', '-y', '-i', 'audio/pcm-bed.m4a', '-c:a', 'pcm_s16le', 'audio/pcm-bed.wav'],
  { cwd: root },
)
