import { spawnSync } from 'node:child_process'

/** Known sRGB patches: greys, primaries, secondaries, two skin tones and a saturated orange. */
export const PATCHES: readonly { name: string; rgb: readonly [number, number, number] }[] = [
  { name: 'grey 0', rgb: [0, 0, 0] },
  { name: 'grey 64', rgb: [64, 64, 64] },
  { name: 'grey 128', rgb: [128, 128, 128] },
  { name: 'grey 192', rgb: [192, 192, 192] },
  { name: 'grey 255', rgb: [255, 255, 255] },
  { name: 'red', rgb: [255, 0, 0] },
  { name: 'green', rgb: [0, 255, 0] },
  { name: 'blue', rgb: [0, 0, 255] },
  { name: 'cyan', rgb: [0, 255, 255] },
  { name: 'magenta', rgb: [255, 0, 255] },
  { name: 'yellow', rgb: [255, 255, 0] },
  { name: 'light skin', rgb: [194, 150, 130] },
  { name: 'dark skin', rgb: [115, 82, 68] },
  { name: 'orange', rgb: [255, 110, 0] },
  { name: 'grey 32', rgb: [32, 32, 32] },
  { name: 'grey 224', rgb: [224, 224, 224] },
]

/** Patch size in pixels: large enough that 4:2:0 chroma at the centre is the patch's own. */
export const CELL = 32
export const COLS = 4

/** The chart as one opaque RGBA frame, 4 patches across. */
export const chartFrame = (): { pixels: Uint8Array; width: number; height: number } => {
  const width = COLS * CELL
  const height = Math.ceil(PATCHES.length / COLS) * CELL
  const pixels = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = PATCHES[Math.floor(y / CELL) * COLS + Math.floor(x / CELL)]
      const [r, g, b] = p?.rgb ?? [0, 0, 0]
      pixels.set([r, g, b, 255], (y * width + x) * 4)
    }
  return { pixels, width, height }
}

/** The colour tags ffprobe reads from a file's first video stream. */
export const probeColor = (file: string) => {
  const r = spawnSync(
    'ffprobe',
    [
      ...['-v', 'error', '-select_streams', 'v:0', '-of', 'json'],
      ...['-show_entries', 'stream=color_space,color_primaries,color_transfer,color_range,pix_fmt'],
      file,
    ],
    { encoding: 'utf8' },
  )
  const s = JSON.parse(r.stdout).streams[0] as { [k: string]: string | undefined }
  return {
    space: s.color_space,
    primaries: s.color_primaries,
    transfer: s.color_transfer,
    range: s.color_range,
    pixFmt: s.pix_fmt,
  }
}

/**
 * Decodes a file's first frame back to RGB as a player does: with the matrix and range its tags
 * state, or BT.709 limited range when it states none (what browsers and players assume for HD).
 */
export const decodeFirstFrame = (file: string): Uint8Array => {
  const tags = probeColor(file)
  const matrix = tags.space && tags.space !== 'unknown' ? tags.space : 'bt709'
  const range = tags.range === 'pc' ? 'pc' : 'tv'
  const r = spawnSync('ffmpeg', [
    ...['-v', 'error', '-i', file, '-frames:v', '1'],
    ...['-vf', `scale=in_color_matrix=${matrix}:in_range=${range},format=rgb24`],
    ...['-f', 'rawvideo', '-'],
  ])
  if (r.status !== 0) throw new Error(String(r.stderr))
  return new Uint8Array(r.stdout)
}

/** Each patch's worst channel error at its centre, decoded RGB against the chart's sRGB. */
export const patchErrors = (rgb: Uint8Array, width: number) =>
  PATCHES.map((p, i) => {
    const x = (i % COLS) * CELL + CELL / 2
    const y = Math.floor(i / COLS) * CELL + CELL / 2
    const at = (y * width + x) * 3
    const got = [rgb[at], rgb[at + 1], rgb[at + 2]] as number[]
    return {
      name: p.name,
      want: p.rgb,
      got,
      error: Math.max(...got.map((v, c) => Math.abs(v - (p.rgb[c] ?? 0)))),
    }
  })
