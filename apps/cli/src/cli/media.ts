import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanProject, treeId } from '../project/revisions.ts'
import { open } from './args.ts'
import { requireFfmpeg } from './ffmpeg.ts'
import { exportVideo } from './render.ts'
import { bytesText } from './site.ts'

/** The poster: the main variant's frame at the film's middle, a webp. */
export const POSTER = { width: 1280, bytes: 500_000 }
/** The hover loop: the main variant's first seconds, a silent H.264 mp4. */
export const LOOP = { width: 480, seconds: 4, bytes: 4_000_000 }

/** Where `share` writes them: under `.shaderera/`, which no revision holds. */
export const mediaDir = (root: string): string => join(root, '.shaderera', 'media')

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Runs ffmpeg, `input` on its stdin; throws its last line of error. */
const ffmpeg = (args: readonly string[], input?: Uint8Array) => {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args], { encoding: 'utf8', input })
  if (r.status !== 0)
    throw new Error(`ffmpeg failed: ${r.stderr.trim().split('\n').at(-1) ?? r.status}`)
}

/** Encodes at each setting in turn until the file fits `max` bytes; throws when none does. */
const fit = (
  out: string,
  max: number,
  settings: readonly string[][],
  what: string,
  input?: Uint8Array,
) => {
  for (const s of settings) {
    ffmpeg([...s, out], input)
    if (statSync(out).size <= max) return out
  }
  rmSync(out, { force: true })
  throw new Error(`${what} is over ${bytesText(max)} even at the lowest quality`)
}

/**
 * The poster and the hover loop the site shows for a shared version (#124), rendered by the CLI's
 * own host from the main variant and sized with ffmpeg into `dir`: the frame at the film's middle
 * as a webp at most 1280 px wide and 500 KB, and the first min(4 s, duration) through render's
 * export as a silent H.264 mp4 480 px wide and at most 4 MB, on the host `hostFlags` name (`--host`,
 * `--trusted`, `--timeout`, as a render's). A render that fails (the film throws, or its host does
 * not open or errors) stops here and is `failed`, which a share refuses. No ffmpeg, or a poster or
 * loop ffmpeg cannot fit, is left out with a warning.
 */
export const renderMedia = async (
  root: string,
  dir: string,
  hostFlags: { host?: unknown; trusted?: unknown; timeout?: unknown } = {},
): Promise<{ poster?: string; loop?: string; warnings: string[]; failed?: string }> => {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  let opened: Awaited<ReturnType<typeof open>>
  try {
    requireFfmpeg()
  } catch (e) {
    return { warnings: [`no poster or loop: ${message(e)}`] }
  }
  try {
    opened = await open({ ...hostFlags, root })
  } catch (e) {
    return { warnings: [], failed: message(e) }
  }
  const { project, child } = opened
  const { width, height, duration } = project.manifest
  const made: { poster?: string; loop?: string } = {}
  const warnings: string[] = []
  const temp = mkdtempSync(join(tmpdir(), 'shaderera-media-'))
  try {
    let pixels: Uint8Array
    try {
      ;({ pixels } = await child.render(duration / 2, 'final'))
    } catch (e) {
      return { warnings, failed: `the poster: ${message(e)}` }
    }
    try {
      // Its RGBA straight to ffmpeg, which scales it: no PNG between.
      const raw = [
        ...['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-i', '-'],
        ...['-vf', `scale=${Math.min(POSTER.width, width)}:-1`],
      ]
      made.poster = fit(
        join(dir, 'poster.webp'),
        POSTER.bytes,
        [80, 60, 40, 20].map((q) => [...raw, '-c:v', 'libwebp', '-quality', String(q)]),
        'the poster',
        pixels,
      )
    } catch (e) {
      warnings.push(`no poster: ${message(e)}`)
    }
    // The film from its first frame: a declared preroll's black is no part of a loop.
    const { preroll: _, ...manifest } = project.manifest
    const full = join(temp, 'loop.mp4')
    try {
      await exportVideo({ ...project, manifest }, child, {
        from: 0,
        to: Math.min(LOOP.seconds, duration),
        out: full,
        audio: false,
        revision: treeId(scanProject(root)),
      })
    } catch (e) {
      return { ...made, warnings, failed: `the loop: ${message(e)}` }
    }
    try {
      const scale = ['-i', full, '-an', '-vf', `scale=${LOOP.width}:-2`, '-c:v', 'libx264']
      made.loop = fit(
        join(dir, 'loop.mp4'),
        LOOP.bytes,
        [23, 28, 34, 40].map((crf) => [
          ...scale,
          ...['-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p'],
          ...['-movflags', '+faststart'],
        ]),
        'the loop',
      )
    } catch (e) {
      warnings.push(`no loop: ${message(e)}`)
    }
  } finally {
    await child.close()
    rmSync(temp, { recursive: true, force: true })
  }
  return { ...made, warnings }
}
