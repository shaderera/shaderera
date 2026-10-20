// A re-paced narration's time map, read as frozen analysis data (shaderera.analysis/1, kind
// "time-map"): knots [old seconds, new seconds] that move a time written against the original
// recording onto the re-paced one. tools/voice-repace.ts writes it beside the new audio; the film
// reads data and runs no ffmpeg.

import type { Host } from '@shaderera/core'

/** What the map file holds. */
export type TimeMap = {
  format: 'shaderera.analysis/1'
  kind: 'time-map'
  /** The original recording, as measured. */
  source: { path: string; bytes: number; sha256: string; seconds: number }
  /** The re-paced recording the film plays. */
  output: { path: string; seconds: number }
  /** The tool and its ffmpeg: provenance only, nothing here is read to render. */
  tool: Record<string, unknown>
  /** Every setting that changed the output. */
  params: Record<string, unknown>
  /** [old seconds, new seconds], old rising; a removed stretch of pause is two knots at one new time. */
  knots: [number, number][]
}

/** The sha256 of the bytes, in hex: how a file names the recording or image it was made from. */
export const hex = async (bytes: Uint8Array) => {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Reads a time map, and refuses it when it is not one or when the recording it names has other
 * bytes than the ones re-paced: a re-recorded voice with an old map would put every cut off its word.
 */
export const loadTimeMap = async (host: Host, path: string): Promise<TimeMap> => {
  const doc = JSON.parse(new TextDecoder().decode(await host.io.read(path))) as TimeMap
  if (doc.format !== 'shaderera.analysis/1' || doc.kind !== 'time-map')
    throw new Error(`${path} is not a shaderera.analysis/1 time-map artifact; run its tool again`)
  if ((await hex(await host.io.read(doc.source.path))) !== doc.source.sha256)
    throw new Error(`${path} was made from other bytes than ${doc.source.path}; run its tool again`)
  return doc
}

/**
 * The re-paced time of `t`, a time on the original recording: between knots by straight lines,
 * inside a removed stretch of pause at the join, and before the first or after the last knot at
 * its own length.
 */
export const pacedTime = (map: TimeMap, t: number) => {
  const k = map.knots
  const [x0, y0] = k[0] ?? [0, 0]
  if (t <= x0) return y0 + (t - x0)
  for (let i = 1; i < k.length; i++) {
    const [a, b] = k[i - 1] as [number, number]
    const [c, d] = k[i] as [number, number]
    if (t <= c) return c === a ? d : b + ((d - b) * (t - a)) / (c - a)
  }
  const [xl, yl] = k[k.length - 1] ?? [0, 0]
  return yl + (t - xl)
}
