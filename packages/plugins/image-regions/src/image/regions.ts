// Named regions of a photograph, read as frozen analysis data (shaderera.analysis/1, kind
// "regions"): each region's mask, box and centre, and the region that holds it. An analyser writes
// them once, apart from rendering (tools/regions-sam.py, tools/regions-from-masks.ts, or any tool
// that writes the same files); the film reads data and runs no model.

import type { Host } from '@shaderera/core'

/** One region, in the source image's pixels (origin top-left, rows downward). */
export type Region = {
  /** `<label>-<n>`, n counting that label's regions from the highest score. */
  id: string
  /** What was asked for or named: "cat", "eye". */
  label: string
  /** The analyser's confidence, 0..1; 1 for a mask a person made. */
  score: number
  /** [x, y, width, height]. */
  box: [number, number, number, number]
  /** The mask's centre of mass. */
  centre: [number, number]
  /** The id of the smallest region that holds this one (an eye's head, a head's cat). */
  parent?: string
  /** u8 coverage 0–255 over the rectangle whose top-left is `at`, beside regions.json. */
  mask: {
    file: string
    dtype: 'u8'
    channels: 1
    width: number
    height: number
    rowStride: number
    at: [number, number]
  }
}

/** What regions.json holds, and the folder it was read from. */
export type Regions = {
  format: 'shaderera.analysis/1'
  kind: 'regions'
  source: { path: string; bytes: number; sha256: string; width: number; height: number }
  /** The analyser, its versions and its model: provenance only, nothing here is read to render. */
  tool: Record<string, unknown>
  /** Every setting that changed the output. */
  params: Record<string, unknown>
  regions: Region[]
  dir: string
}

/** The sha256 of the bytes, in hex: how a file names the recording or image it was made from. */
export const hex = async (bytes: Uint8Array) => {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Reads `<dir>/regions.json`, and refuses it when it is not a regions artifact or when the image it
 * names has other bytes than the ones measured: a changed photograph with old regions would put
 * every piece in the wrong place.
 */
export const loadRegions = async (host: Host, dir: string): Promise<Regions> => {
  const path = `${dir}/regions.json`
  const doc = JSON.parse(new TextDecoder().decode(await host.io.read(path))) as Omit<Regions, 'dir'>
  if (doc.format !== 'shaderera.analysis/1' || doc.kind !== 'regions')
    throw new Error(
      `${path} is not a shaderera.analysis/1 regions artifact; run its analyser again`,
    )
  if ((await hex(await host.io.read(doc.source.path))) !== doc.source.sha256)
    throw new Error(
      `${dir} was measured from other bytes than ${doc.source.path}; run its analyser again`,
    )
  return { ...doc, dir }
}

/** The region with this id. */
export const region = (r: Regions, id: string) => {
  const found = r.regions.find((q) => q.id === id)
  if (!found)
    throw new Error(
      `${r.dir} has no region "${id}": it has ${r.regions.map((q) => q.id).join(', ')}`,
    )
  return found
}

/**
 * The regions with `label` that hold no other region with that label: of an analyser's nested
 * answers (an eyeball inside the eye inside both eyes), the innermost.
 */
export const leaves = (r: Regions, label: string) => {
  const of = r.regions.filter((q) => q.label === label)
  return of.filter((q) => !of.some((c) => c.parent === q.id))
}

/** A region's mask: `width × height` coverage bytes, rows `rowStride` apart, at `mask.at`. */
export const maskOf = async (host: Host, r: Regions, q: Region) => {
  const bytes = await host.io.read(`${r.dir}/${q.mask.file}`)
  if (bytes.length !== q.mask.rowStride * q.mask.height)
    throw new Error(
      `${r.dir}/${q.mask.file} has ${bytes.length} bytes, not ${q.mask.rowStride} × ${q.mask.height}`,
    )
  return bytes
}
