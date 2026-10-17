// Takes of a recording heard as matching a description, read as frozen analysis data
// (shaderera.analysis/1, kind "sound-trims"): each trim's start and end in seconds of the
// recording, and its peak, the loudest moment, so a film can land the peak on a hit point.
// tools/listen.ts writes it with CLAP; the film reads data and runs no model.

import type { Host } from '@shaderera/core'

/** One take: a stretch of the recording, best first. */
export type Trim = {
  /** `take-1` is the best match, `take-2` the next. */
  id: string
  /** Where the clip starts and stops reading, in seconds of the recording. */
  start: number
  end: number
  /** The loudest moment, in seconds of the recording: the centre of the loudest 5 ms. */
  peak: number
  /** CLAP's similarity of the take to the description, -1 to 1: compare takes of one search. */
  cosine: number
  /** 1 when no other description fits the take better; 3 when two do. */
  rank: number
  /** How far the description stands above the other descriptions, in their spread. */
  z: number
  /** The description that fits the take best: the query itself when `rank` is 1. */
  heardAs: string
  /** `stroke` (from an onset until it has decayed) or `window` (a plain stretch, to crossfade). */
  kind: string
}

/** What the trims file holds. */
export type Trims = {
  format: 'shaderera.analysis/1'
  kind: 'sound-trims'
  /** The recording, as measured. */
  source: { path: string; bytes: number; sha256: string; seconds: number }
  /** The tool, the model and its revision, ffmpeg: provenance only, nothing here is read to render. */
  tool: Record<string, unknown>
  /** The description searched for, and every setting that changed the answer. */
  params: { query: string } & Record<string, unknown>
  trims: Trim[]
}

const hex = async (bytes: Uint8Array) => {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Reads a trims file, and refuses it when it is not one or when the recording it names has other
 * bytes than the ones heard: a replaced recording with old trims would play the wrong moments.
 */
export const loadTrims = async (host: Host, path: string): Promise<Trims> => {
  const doc = JSON.parse(new TextDecoder().decode(await host.io.read(path))) as Trims
  if (doc.format !== 'shaderera.analysis/1' || doc.kind !== 'sound-trims')
    throw new Error(
      `${path} is not a shaderera.analysis/1 sound-trims artifact; run its tool again`,
    )
  if ((await hex(await host.io.read(doc.source.path))) !== doc.source.sha256)
    throw new Error(`${path} was made from other bytes than ${doc.source.path}; run its tool again`)
  return doc
}

/**
 * The clip that plays `trim` with its peak on `hitPoint`, a time of the film in seconds: it starts
 * earlier by the peak's lead. When that would be before the film starts, the take loses its head
 * instead, and the peak still lands.
 */
export const clipAt = (trims: Trims, trim: Trim, hitPoint: number) => {
  const at = hitPoint - (trim.peak - trim.start)
  return at >= 0
    ? { src: trims.source.path, from: trim.start, to: trim.end, at }
    : { src: trims.source.path, from: trim.start - at, to: trim.end, at: 0 }
}
