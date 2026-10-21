// Converts images the film cannot decode the same everywhere (WebP, AVIF, GIF…) to PNG, once,
// beside the originals:
//   node tools/to-png.ts assets/*.webp            # assets/x.webp → assets/x.png
//   node tools/to-png.ts --frames 12 clip.webm    # a video's frames: clip-000.png … (12 per second)
// The PNGs are what the film reads. Pixels are kept as they are (no resizing, no colour change),
// so the artwork's colours survive. Needs ffmpeg on PATH.

import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { frames: { type: 'string' }, out: { type: 'string' } },
})
if (positionals.length === 0) throw new Error('Usage: node tools/to-png.ts [--frames fps] <files…>')
for (const file of positionals) {
  const stem = file.replace(/\.[^./\\]+$/, '')
  const args = values.frames
    ? [
        '-v',
        'error',
        '-y',
        '-i',
        file,
        '-vf',
        `fps=${values.frames}`,
        '-pix_fmt',
        'rgba',
        `${stem}-%03d.png`,
      ]
    : ['-v', 'error', '-y', '-i', file, '-frames:v', '1', '-pix_fmt', 'rgba', `${stem}.png`]
  execFileSync('ffmpeg', args)
  console.log(
    values.frames ? `${file} → ${stem}-NNN.png at ${values.frames} fps` : `${file} → ${stem}.png`,
  )
}
