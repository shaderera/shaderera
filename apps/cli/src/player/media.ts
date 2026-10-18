// The proxies a web player decodes in the browser, made with ffmpeg when the player is built. A
// film's clip may be anything ffmpeg reads (ProRes, a GOP of 250, 10-bit); the browser's WebCodecs
// decodes H.264 everywhere, and seeks quickly with a short GOP. So each video in the film gets an
// H.264 copy with the same frames, beside its info as `io.video` reads the original
// (node/services.ts probeVideo): a film sees the same width, height, fps and frame count in every
// host.
import { spawnSync } from 'node:child_process'
import { probeVideo, type VideoInfo } from '../node/services.ts'

/** The film's files `io.video` may open: what the build makes a proxy for. */
export const VIDEO = /\.(mp4|m4v|mov|webm|mkv)$/i

/** A keyframe every this many frames: a seek decodes at most this many to reach any frame. */
export const GOP = 15

/**
 * An H.264 copy of `from`'s first video stream: every frame kept with its timestamp, converted to
 * BT.709 limited range by the original's own colour tags (as `io.video` reads them), yuv420p, a
 * keyframe every GOP frames, no B-frames, no audio, no metadata. Checked against the original's
 * frame count and size; returns the original's info.
 */
export const makeProxy = (from: string, to: string): VideoInfo => {
  const info = probeVideo(from)
  if (info.width % 2 || info.height % 2)
    throw new Error(
      `${from} is ${info.width}×${info.height}: the player's proxy needs an even width and height.`,
    )
  // biome-ignore format: one flag and its value a line
  const r = spawnSync('ffmpeg', [
    '-v', 'error', '-y',
    '-i', from,
    '-map', '0:v:0', '-an', '-sn', '-dn', '-map_metadata', '-1',
    '-vf', 'scale=in_color_matrix=auto:in_range=auto:out_color_matrix=bt709:out_range=tv,format=yuv420p',
    '-fps_mode', 'passthrough',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-g', String(GOP), '-keyint_min', String(GOP), '-sc_threshold', '0', '-bf', '0',
    '-threads', '1',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
    '-movflags', '+faststart', '-fflags', '+bitexact', '-flags:v', '+bitexact',
    to,
  ], { encoding: 'utf8' })
  if (r.error)
    throw new Error(`ffmpeg is needed to build a player with footage: ${r.error.message}`)
  if (r.status !== 0)
    throw new Error(`ffmpeg could not make a proxy of ${from}: ${r.stderr.trim()}`)
  const made = probeVideo(to)
  if (made.frames !== info.frames || made.width !== info.width || made.height !== info.height)
    throw new Error(
      `The proxy of ${from} has ${made.frames} frames at ${made.width}×${made.height}, the original ${info.frames} at ${info.width}×${info.height}.`,
    )
  return info
}
