// A Lottie file's keyframes as reference tracks (shaderera.analysis/1, kind "reference-tracks"),
// so a film reads a Lottie reference through analysis-reference-tracks' reader, as it reads a
// captured page. Run once: node tools/lottie-tracks.ts assets/intro.json --fps 30
//
// - `declared` keeps what the file writes, as motion-lottie-read reads it: the composition, its
//   markers, each layer, and each transform property with its keys (frame, t, value, hold, handles,
//   path tangents) and the unit of each field. Nothing is fitted or named.
// - `tracks` are one per layer and property dimension (`p[0]`, `p[1]`, `r[0]`), sampled with
//   `valueAt` at the frame rate given (required: it sets every sample time), from the file's in
//   point to its out point. A sample outside the layer's own in and out points is null: the layer
//   is not there.
// - `limits` are the reader's `unsupported`, each where it is in the file.

import { parseFps } from '@shaderera/core'
import { readLottie, valueAt } from '../src/motion/lottie.ts'
import type { Declared, Limit, Sample, Track } from '../src/reference/tracks.ts'
import { fileSource, type TracksDoc, tracksJson } from './reference-tracks.ts'

/** This tool's version, recorded in every artifact. */
export const VERSION = '0.1.2'

/** Each transform property's unit, as Lottie writes it. */
const UNITS: Record<string, string> = {
  a: 'source-px',
  p: 'source-px',
  px: 'source-px',
  py: 'source-px',
  pz: 'source-px',
  s: 'percent',
  r: 'deg',
  o: 'percent',
  sk: 'deg',
  sa: 'deg',
  rx: 'deg',
  ry: 'deg',
  rz: 'deg',
  or: 'deg',
}

/**
 * The reference-tracks document of a Lottie file: `path` from the project root, its `bytes`, and
 * `fps`, the rate to sample at (a number, or a fraction like "24000/1001"). Refuses a missing or
 * bad fps, and a file motion-lottie-read refuses.
 */
export const lottieTracks = async (o: {
  path: string
  bytes: Uint8Array
  fps: number | string
}): Promise<TracksDoc> => {
  const rate = parseFps(o.fps)
  if (!rate)
    throw new Error(
      `lottie-tracks needs fps, the rate to sample at, not ${JSON.stringify(o.fps)}: it sets every sample's time`,
    )
  const lottie = readLottie(new TextDecoder().decode(o.bytes))
  const unit = (name: string) => (Object.hasOwn(UNITS, name) ? (UNITS[name] as string) : 'unknown')
  const { layers, markers, unsupported, ...composition } = lottie
  const declared: Declared[] = [
    {
      ...composition,
      element: 'composition',
      type: 'lottie-composition',
      units: {
        fr: 'frame/s',
        ip: 'frame',
        op: 'frame',
        in: 's',
        out: 's',
        width: 'source-px',
        height: 'source-px',
      },
    },
    ...markers.map((m) => ({
      ...m,
      element: 'composition',
      type: 'lottie-marker',
      units: { frame: 'frame', t: 's', frames: 'frame', duration: 's' },
    })),
  ]
  const limits: Limit[] = unsupported.map((u) => ({
    where: u.where,
    reason: `${u.feature}: not read`,
  }))
  // Sample times k / fps from the file's in point to its out point, the out point not included.
  const times: number[] = []
  for (let k = Math.ceil((lottie.in * rate.num) / rate.den - 1e-9); ; k++) {
    const t = (k * rate.den) / rate.num
    if (t >= lottie.out - 1e-12) break
    times.push(t)
  }
  const tracks: Track[] = []
  for (const layer of layers) {
    const element = `layers[${layer.index}]`
    // `ty` as written; the reader's name for it is not the file's, and `type` names the entry.
    const { transform, type: _name, ...rest } = layer
    declared.push({
      ...rest,
      element,
      type: 'lottie-layer',
      units: { ip: 'frame', op: 'frame', in: 's', out: 's', st: 'frame', sr: 'ratio' },
    })
    for (const property of Object.values(transform)) {
      const u = unit(property.name)
      declared.push({
        element,
        type: 'lottie-property',
        name: property.name,
        path: property.path,
        animated: property.animated,
        value: property.value,
        keys: property.keys,
        ...(property.expression === undefined ? {} : { expression: property.expression }),
        units: {
          frame: 'frame',
          t: 's',
          value: u,
          end: u,
          pathOut: u,
          pathIn: u,
          out: 'ratio',
          in: 'ratio',
        },
      })
      if (u === 'unknown')
        limits.push({ where: property.path, reason: `the unit of ${property.name} is not known` })
      // An animated 3D orientation is in `unsupported`; valueAt refuses it, so it has no samples.
      if (property.name === 'or' && property.keys.length > 0) continue
      const values = times.map((t): number[] | null =>
        t >= layer.in && t < layer.out ? valueAt(property, t) : null,
      )
      const dims = Math.max(property.value.length, ...values.map((v) => v?.length ?? 0))
      for (let d = 0; d < dims; d++)
        tracks.push({
          element,
          channel: `${property.name}[${d}]`,
          unit: u,
          samples: times.map((t, i): Sample => [t, values[i]?.[d] ?? null]),
        })
    }
  }
  return {
    format: 'shaderera.analysis/1',
    kind: 'reference-tracks',
    source: await fileSource(o.path, o.bytes),
    tool: { script: 'tools/lottie-tracks.ts', version: VERSION },
    params: { fps: o.fps },
    frame: { width: lottie.width, height: lottie.height, pixelRatio: 1 },
    tracks,
    declared,
    limits,
  }
}

if (import.meta.main) {
  const { parseArgs } = await import('node:util')
  const { readFileSync, writeFileSync } = await import('node:fs')
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: { fps: { type: 'string' }, out: { type: 'string' } },
    })
    const path = positionals[0]?.replaceAll('\\', '/')
    if (positionals.length !== 1 || !path)
      throw new Error('usage: node tools/lottie-tracks.ts <file.json> --fps <n> [--out <file>]')
    if (values.fps === undefined) throw new Error('give --fps: it sets every sample time')
    const fps = /^\s*\d+\s*\/\s*\d+\s*$/.test(values.fps) ? values.fps : Number(values.fps)
    const out = values.out ?? path.replace(/(\.json)?$/i, '.tracks.json')
    const doc = await lottieTracks({ path, bytes: readFileSync(path), fps })
    writeFileSync(out, tracksJson(doc))
    console.log(`${out}: ${doc.tracks.length} tracks, ${doc.limits.length} limits`)
    for (const l of doc.limits) console.log(`  ${l.where}: ${l.reason}`)
  } catch (e) {
    console.error((e as Error).message)
    process.exitCode = 1
  }
}
