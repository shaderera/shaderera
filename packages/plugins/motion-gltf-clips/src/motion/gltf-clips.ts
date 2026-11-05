// A glTF file's animation clips, read as written: each animation's name and channels (target
// node, path, interpolation, input times and output values exactly as the accessors hold them,
// read with render-gltf-read's accessor reader). `valueAt` plays a channel by the glTF 2.0 spec's
// own rules: STEP holds, LINEAR is a lerp (a slerp for rotation), CUBICSPLINE is the Hermite
// spline with the file's in and out tangents. Skins and morph targets are reported as present,
// not applied. Pure functions of the file, so any t gives the same value at any time.

import { type GltfFile, openGltf } from '../render/gltf.ts'

export type GltfPath = 'translation' | 'rotation' | 'scale' | 'weights'
export type GltfInterpolation = 'STEP' | 'LINEAR' | 'CUBICSPLINE'

/** One channel: one property of one node, with its sampler's keys. */
export type GltfChannel = {
  /** `target.node`, and that node's name when it has one. */
  node: number
  nodeName?: string
  path: GltfPath
  /** The sampler's interpolation; LINEAR when the file leaves it out, as the spec says. */
  interpolation: GltfInterpolation
  /** The sampler's index in its animation. */
  sampler: number
  /** Key times in seconds, as the input accessor holds them. */
  input: Float32Array
  /**
   * Values as the output accessor holds them, `width` numbers a value. CUBICSPLINE stores three a
   * key: in-tangent, value, out-tangent.
   */
  output: Float32Array
  /** Numbers a value: 3 for translation and scale, 4 for rotation (x, y, z, w), the morph
   * target count for weights. */
  width: number
}

export type GltfClip = {
  /** The animation's index in the file, and its name when it has one. */
  index: number
  name?: string
  channels: GltfChannel[]
  /** The first and last key time of all its channels, in seconds. */
  start: number
  end: number
}

export type GltfClips = {
  clips: GltfClip[]
  /** Skins the file has: present, not applied. */
  skins: { index: number; name?: string; joints: number }[]
  /** Meshes with morph targets: present, not applied (a `weights` channel drives them). */
  morphTargets: { mesh: number; name?: string; targets: number }[]
  /** Channels this reader does not read (no target node, or a path an extension adds), by where. */
  unread: string[]
}

const PATHS = new Set<string>(['translation', 'rotation', 'scale', 'weights'])
const INTERPOLATIONS = new Set<string>(['STEP', 'LINEAR', 'CUBICSPLINE'])
const WIDTH: Record<string, number> = { translation: 3, rotation: 4, scale: 3 }

const fail = (where: string, what: string): never => {
  throw new Error(`motion-gltf-clips: ${where} ${what}`)
}

/** Reads the animation clips of a file opened with render-gltf-read's `openGltf`. */
export const readClips = (gltf: GltfFile): GltfClips => {
  const doc = gltf.json
  const nodes = (doc.nodes ?? []) as Record<string, unknown>[]
  const meshes = (doc.meshes ?? []) as { name?: string; primitives?: { targets?: unknown[] }[] }[]
  const targetsOf = (mesh: number) => meshes[mesh]?.primitives?.[0]?.targets?.length ?? 0
  const unread: string[] = []
  const clips = ((doc.animations ?? []) as Record<string, unknown>[]).map((a, index): GltfClip => {
    const samplers = (a.samplers ?? []) as Record<string, unknown>[]
    const channels: GltfChannel[] = []
    for (const [c, ch] of ((a.channels ?? []) as Record<string, unknown>[]).entries()) {
      const where = `animations[${index}].channels[${c}]`
      const target = (ch.target ?? {}) as { node?: number; path?: string }
      if (target.node === undefined || !PATHS.has(String(target.path))) {
        unread.push(`${where}: path ${target.path}${target.node === undefined ? ', no node' : ''}`)
        continue
      }
      const node = nodes[target.node] ?? fail(`${where}.target.node`, `is ${target.node}, no node`)
      const s = Number(ch.sampler)
      const sampler = samplers[s] ?? fail(`${where}.sampler`, `is ${ch.sampler}, no sampler`)
      const interpolation = String(sampler.interpolation ?? 'LINEAR')
      if (!INTERPOLATIONS.has(interpolation))
        fail(`animations[${index}].samplers[${s}].interpolation`, `is ${interpolation}`)
      const input = gltf.accessor(Number(sampler.input))
      const output = gltf.accessor(Number(sampler.output))
      const at = `animations[${index}].samplers[${s}]`
      if (input.length === 0) fail(`${at}.input`, 'has no keys')
      for (let k = 1; k < input.length; k++)
        if (!((input[k] as number) > (input[k - 1] as number)))
          fail(`${at}.input`, `key ${k} at ${input[k]} s is not after ${input[k - 1]} s`)
      const perKey = interpolation === 'CUBICSPLINE' ? 3 : 1
      const width = output.length / (input.length * perKey)
      const path = target.path as GltfPath
      const want = WIDTH[path] ?? (typeof node.mesh === 'number' ? targetsOf(node.mesh) : width)
      if (width !== want || !Number.isInteger(width) || width === 0)
        fail(
          `${at}.output`,
          `holds ${output.length} numbers: ${input.length} keys × ${perKey} × ${want} for ${path}`,
        )
      const channel: GltfChannel = {
        node: target.node,
        path,
        interpolation: interpolation as GltfInterpolation,
        sampler: s,
        input,
        output,
        width,
      }
      if (typeof node.name === 'string') channel.nodeName = node.name
      channels.push(channel)
    }
    const times = channels.flatMap((ch) => [ch.input[0] as number, ch.input.at(-1) as number])
    const clip: GltfClip = {
      index,
      channels,
      start: times.length ? Math.min(...times) : 0,
      end: times.length ? Math.max(...times) : 0,
    }
    if (typeof a.name === 'string') clip.name = a.name
    return clip
  })
  const skins = ((doc.skins ?? []) as { name?: string; joints?: number[] }[]).map((s, index) => ({
    index,
    ...(s.name === undefined ? {} : { name: s.name }),
    joints: s.joints?.length ?? 0,
  }))
  const morphTargets = meshes.flatMap((m, mesh) => {
    const targets = targetsOf(mesh)
    return targets ? [{ mesh, ...(m.name === undefined ? {} : { name: m.name }), targets }] : []
  })
  return { clips, skins, morphTargets, unread }
}

/** Reads a model's clips: `await loadClips(host, 'assets/arm.glb')`. */
export const loadClips = async (
  host: { io: { read(path: string): Promise<Uint8Array> } },
  path: string,
) => readClips(await openGltf((p) => host.io.read(p), path))

/** Value k of a channel: for CUBICSPLINE, part 0 is the in-tangent, 1 the value, 2 the out-tangent. */
const part = (ch: GltfChannel, k: number, p = 1) => {
  const n = ch.width
  const o = ch.interpolation === 'CUBICSPLINE' ? (k * 3 + p) * n : k * n
  return Array.from(ch.output.subarray(o, o + n))
}

/** The spec's slerp: a = acos(|q0 · q1|), q1 taken on the side of q0; a lerp where a is 0. */
const slerp = (q0: number[], q1: number[], u: number) => {
  const d = q0.reduce((s, x, i) => s + x * (q1[i] as number), 0)
  const sign = d < 0 ? -1 : 1
  const a = Math.acos(Math.min(1, Math.abs(d)))
  const sa = Math.sin(a)
  if (sa < 1e-12) return q0.map((x, i) => x + (sign * (q1[i] as number) - x) * u)
  const w0 = Math.sin(a * (1 - u)) / sa
  const w1 = (sign * Math.sin(a * u)) / sa
  return q0.map((x, i) => w0 * x + w1 * (q1[i] as number))
}

/**
 * A channel's value at t seconds of the file, by the glTF 2.0 spec: STEP holds a key's value until
 * the next key; LINEAR lerps, and slerps a rotation; CUBICSPLINE is the Hermite spline
 * (2u³ − 3u² + 1)·v₀ + td·(u³ − 2u² + u)·b₀ + (−2u³ + 3u²)·v₁ + td·(u³ − u²)·a₁, a rotation
 * normalised after. Before the first key it is the first value; after the last, the last.
 */
export const valueAt = (channel: GltfChannel, t: number): number[] => {
  if (!Number.isFinite(t)) fail('valueAt: t', `is ${t}, not a number of seconds`)
  const { input } = channel
  const last = input.length - 1
  if (t <= (input[0] as number)) return part(channel, 0)
  if (t >= (input[last] as number)) return part(channel, last)
  let k = 0
  while ((input[k + 1] as number) <= t) k++
  if (channel.interpolation === 'STEP') return part(channel, k)
  const t0 = input[k] as number
  const td = (input[k + 1] as number) - t0
  const u = (t - t0) / td
  if (channel.interpolation === 'LINEAR') {
    const v0 = part(channel, k)
    const v1 = part(channel, k + 1)
    if (channel.path === 'rotation') return slerp(v0, v1, u)
    return v0.map((x, i) => x + ((v1[i] as number) - x) * u)
  }
  const v0 = part(channel, k)
  const b0 = part(channel, k, 2)
  const v1 = part(channel, k + 1)
  const a1 = part(channel, k + 1, 0)
  const u2 = u * u
  const u3 = u2 * u
  const out = v0.map(
    (x, i) =>
      (2 * u3 - 3 * u2 + 1) * x +
      td * (u3 - 2 * u2 + u) * (b0[i] as number) +
      (-2 * u3 + 3 * u2) * (v1[i] as number) +
      td * (u3 - u2) * (a1[i] as number),
  )
  if (channel.path !== 'rotation') return out
  const len = Math.hypot(...out)
  return len > 0 ? out.map((x) => x / len) : out
}
