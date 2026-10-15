// glTF 2.0 read into plain data: a `.gltf` with its `.bin` (or data: URIs), or a `.glb`. Each
// primitive the scene draws comes back as typed arrays, its node's world matrix and its material
// as the file states it. Nothing is converted, centred, decoded or shaded: units, placement,
// textures and materials are the film's. What it cannot read it refuses by name (Draco, meshopt,
// any other required extension, primitives that are not triangles), never with wrong geometry.

import type { Mat4 } from '@shaderera/core'

/** An image a material names: a project path, or the bytes inside the file (a GLB, a data: URI). */
export type GltfTexture = {
  /** Relative to the project root, as `io.image` takes it; absent when the image is embedded. */
  path?: string
  /** An embedded image's bytes, with its `mimeType` (image/png, image/jpeg). */
  bytes?: Uint8Array
  mimeType?: string
  /** Which uv set it is sampled with: 0 is `uvs`; others are not read. */
  texCoord: number
}

/** A material as the file states it; glTF's default material when a primitive names none. */
export type GltfMaterial = {
  name?: string
  /** The base colour factor, linear RGBA, multiplied with `textures.baseColor` when there is one. */
  baseColor: [number, number, number, number]
  alphaMode: 'OPAQUE' | 'MASK' | 'BLEND'
  /** The MASK threshold. */
  alphaCutoff: number
  doubleSided: boolean
  textures: {
    baseColor?: GltfTexture
    metallicRoughness?: GltfTexture
    normal?: GltfTexture
    occlusion?: GltfTexture
    emissive?: GltfTexture
  }
}

/** One triangle primitive, once for every node that draws its mesh. */
export type GltfPrimitive = {
  /** The node's name, else its mesh's, else `node-<i>`. */
  name: string
  /** Indices into the file's nodes, meshes and the mesh's primitives. */
  node: number
  mesh: number
  primitive: number
  /** Vertices. */
  count: number
  /** x, y, z in the primitive's own space: put through `matrix` for the scene. */
  positions: Float32Array
  /** x, y, z, as stored (unit length in a valid file); absent when the file has none. */
  normals?: Float32Array
  /** TEXCOORD_0 as u, v, origin top-left as glTF has it; absent when the file has none. */
  uvs?: Float32Array
  /** Three a triangle; 0, 1, 2… for a primitive the file does not index. */
  indices: Uint32Array
  /** The node's world matrix (its parents' times its own), column-major. */
  matrix: Mat4
  material: GltfMaterial
}

export type Gltf = {
  primitives: GltfPrimitive[]
  /** What the file has and this reader leaves out: skins, morph targets, animations, extensions. */
  unread: string[]
}

/** Required extensions this reader does read; any other one is refused. */
const READS = new Set(['KHR_mesh_quantization'])
const MODES = ['POINTS', 'LINES', 'LINE_LOOP', 'LINE_STRIP', 'TRIANGLES', 'TRIANGLE_STRIP']
const COMPONENTS: Record<
  number,
  [size: number, get: (v: DataView, o: number) => number, max: number]
> = {
  5120: [1, (v, o) => v.getInt8(o), 127],
  5121: [1, (v, o) => v.getUint8(o), 255],
  5122: [2, (v, o) => v.getInt16(o, true), 32767],
  5123: [2, (v, o) => v.getUint16(o, true), 65535],
  5125: [4, (v, o) => v.getUint32(o, true), 0],
  5126: [4, (v, o) => v.getFloat32(o, true), 0],
}
const WIDTHS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }

/** The file's JSON, checked where a value is used. */
// biome-ignore lint/suspicious/noExplicitAny: glTF's JSON, checked where it is read
type Json = Record<string, any>

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength)

/** `dir` and a relative `uri` joined, `.` and `..` resolved: a project path. */
const resolve = (dir: string, uri: string) => {
  const out: string[] = []
  for (const part of `${dir}${decodeURIComponent(uri)}`.split('/'))
    if (part === '..') out.pop()
    else if (part !== '.' && part !== '') out.push(part)
  return out.join('/')
}

const dataUri = (uri: string) => {
  const comma = uri.indexOf(',')
  const head = uri.slice(5, comma)
  const body = uri.slice(comma + 1)
  const bytes = head.endsWith(';base64')
    ? Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(body))
  return { bytes, mimeType: head.replace(/;base64$/, '') || undefined }
}

/** The GLB container: its JSON and its binary chunk. */
const unpackGlb = (bytes: Uint8Array) => {
  const v = view(bytes)
  if (v.getUint32(4, true) !== 2)
    throw new Error(`A GLB of version ${v.getUint32(4, true)}; only 2 is read`)
  const end = Math.min(v.getUint32(8, true), bytes.length)
  let json: Json | undefined
  let bin: Uint8Array | undefined
  for (let o = 12; o + 8 <= end; ) {
    const length = v.getUint32(o, true)
    const type = v.getUint32(o + 4, true)
    const chunk = bytes.subarray(o + 8, o + 8 + length)
    if (chunk.length !== length) throw new Error('The GLB ends inside a chunk')
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk))
    else if (type === 0x004e4942 && !bin) bin = chunk
    o += 8 + length
  }
  if (!json) throw new Error('The GLB has no JSON chunk')
  return { json, bin }
}

/** The 4×4 column-major product a × b. */
const multiply = (a: Mat4, b: Mat4) => {
  const out = new Array<number>(16)
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += (a[k * 4 + r] ?? 0) * (b[c * 4 + k] ?? 0)
      out[c * 4 + r] = s
    }
  return out
}

/** A node's own transform: its matrix, or translation × rotation × scale. */
const local = (node: Json): Mat4 => {
  if (node.matrix) return [...node.matrix]
  const [tx, ty, tz] = node.translation ?? [0, 0, 0]
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1]
  const [sx, sy, sz] = node.scale ?? [1, 1, 1]
  return [
    (1 - 2 * (y * y + z * z)) * sx,
    2 * (x * y + z * w) * sx,
    2 * (x * z - y * w) * sx,
    0,
    2 * (x * y - z * w) * sy,
    (1 - 2 * (x * x + z * z)) * sy,
    2 * (y * z + x * w) * sy,
    0,
    2 * (x * z + y * w) * sz,
    2 * (y * z - x * w) * sz,
    (1 - 2 * (x * x + y * y)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ]
}

/**
 * Reads a glTF 2.0 file into plain data, the scene's primitives in node order. `read` gives a
 * project file's bytes (`host.io.read`, or a map in a test); `path` is the file's, so its `.bin`
 * and images are found beside it. A `.glb` is told by its bytes, not its name.
 */
export const readGltf = async (
  read: (path: string) => Promise<Uint8Array>,
  path: string,
): Promise<Gltf> => {
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''
  const file = await read(path)
  const glb = file.length >= 12 && view(file).getUint32(0, true) === 0x46546c67
  const { json: doc, bin } = glb
    ? unpackGlb(file)
    : { json: JSON.parse(new TextDecoder().decode(file)) as Json, bin: undefined }

  const version = String(doc.asset?.version ?? '')
  if (!version.startsWith('2.'))
    throw new Error(`${path} is glTF ${version || 'without a version'}; only 2.0 is read`)
  const refused = ((doc.extensionsRequired ?? []) as string[]).filter((e) => !READS.has(e))
  if (refused.length)
    throw new Error(`${path} requires ${refused.join(', ')}, which this reader does not read`)
  const unread = ((doc.extensionsUsed ?? []) as string[])
    .filter((e) => !READS.has(e))
    .map((e) => `extension ${e}`)
  if (doc.animations?.length) unread.push('animations')

  // Buffers: the GLB's binary chunk, a data: URI, or a file beside this one.
  const buffers = await Promise.all(
    ((doc.buffers ?? []) as Json[]).map(async (b, i) => {
      const bytes =
        b.uri === undefined
          ? glb && i === 0
            ? bin
            : undefined
          : b.uri.startsWith('data:')
            ? dataUri(b.uri).bytes
            : await read(resolve(dir, b.uri))
      if (!bytes) throw new Error(`${path}: buffer ${i} has no uri and no GLB binary chunk`)
      if (bytes.length < b.byteLength)
        throw new Error(`${path}: buffer ${i} has ${bytes.length} bytes, not ${b.byteLength}`)
      return bytes
    }),
  )
  const viewOf = (i: number) => {
    const bv = doc.bufferViews?.[i]
    const buffer = buffers[bv?.buffer]
    if (!bv || !buffer) throw new Error(`${path}: no buffer view ${i}`)
    const start = bv.byteOffset ?? 0
    if (start + bv.byteLength > buffer.length)
      throw new Error(`${path}: buffer view ${i} runs past its buffer`)
    return {
      bytes: buffer.subarray(start, start + bv.byteLength),
      stride: bv.byteStride as number | undefined,
    }
  }

  /** An accessor's values, normalised integers turned to 0..1 (or -1..1), sparse ones applied. */
  const accessor = <T extends Float32Array | Uint32Array>(
    i: number,
    make: new (n: number) => T,
    what: string,
  ): T => {
    const a = doc.accessors?.[i]
    const width = WIDTHS[a?.type]
    const component = COMPONENTS[a?.componentType]
    if (!a || !width || !component)
      throw new Error(`${path}: ${what} is accessor ${i}, which is not a scalar or vector`)
    const [size, get, max] = component
    const out = new make(a.count * width)
    const at = (v: DataView, o: number) => {
      const x = get(v, o)
      return a.normalized && max ? Math.max(x / max, -1) : x
    }
    if (a.bufferView !== undefined) {
      const { bytes, stride = width * size } = viewOf(a.bufferView)
      const start = a.byteOffset ?? 0
      if (a.count && start + (a.count - 1) * stride + width * size > bytes.length)
        throw new Error(`${path}: accessor ${i} runs past its buffer view`)
      const v = view(bytes)
      for (let n = 0; n < a.count; n++)
        for (let k = 0; k < width; k++) out[n * width + k] = at(v, start + n * stride + k * size)
    }
    if (a.sparse) {
      const { count, indices, values } = a.sparse
      const iv = view(viewOf(indices.bufferView).bytes)
      const vv = view(viewOf(values.bufferView).bytes)
      const [isize, iget] = COMPONENTS[indices.componentType] ?? []
      if (!isize || !iget)
        throw new Error(`${path}: accessor ${i} has sparse indices of an unknown type`)
      for (let s = 0; s < count; s++) {
        const n = iget(iv, (indices.byteOffset ?? 0) + s * isize)
        if (n >= a.count) throw new Error(`${path}: accessor ${i} has a sparse index past its end`)
        for (let k = 0; k < width; k++)
          out[n * width + k] = at(vv, (values.byteOffset ?? 0) + (s * width + k) * size)
      }
    }
    return out
  }

  const texture = (info: Json | undefined): GltfTexture | undefined => {
    const image = doc.images?.[doc.textures?.[info?.index]?.source]
    if (!info || !image) return undefined
    const texCoord = info.texCoord ?? 0
    if (image.bufferView !== undefined)
      return { bytes: viewOf(image.bufferView).bytes, mimeType: image.mimeType, texCoord }
    if (String(image.uri).startsWith('data:')) return { ...dataUri(image.uri), texCoord }
    return { path: resolve(dir, image.uri), texCoord }
  }
  const material = (i: number | undefined): GltfMaterial => {
    const m: Json = i === undefined ? {} : (doc.materials?.[i] ?? {})
    const pbr = m.pbrMetallicRoughness ?? {}
    const textures: GltfMaterial['textures'] = {}
    for (const [slot, info] of [
      ['baseColor', pbr.baseColorTexture],
      ['metallicRoughness', pbr.metallicRoughnessTexture],
      ['normal', m.normalTexture],
      ['occlusion', m.occlusionTexture],
      ['emissive', m.emissiveTexture],
    ] as const) {
      const t = texture(info)
      if (t) textures[slot] = t
    }
    return {
      ...(m.name === undefined ? {} : { name: m.name }),
      baseColor: [...(pbr.baseColorFactor ?? [1, 1, 1, 1])] as GltfMaterial['baseColor'],
      alphaMode: m.alphaMode ?? 'OPAQUE',
      alphaCutoff: m.alphaCutoff ?? 0.5,
      doubleSided: m.doubleSided ?? false,
      textures,
    }
  }

  // The scene's nodes, parents first; without a scene, every node no other node holds.
  const nodes = (doc.nodes ?? []) as Json[]
  const scene = doc.scenes?.[doc.scene ?? 0]
  const roots: number[] =
    scene?.nodes ??
    nodes.map((_, i) => i).filter((i) => !nodes.some((n) => n.children?.includes(i)))
  const primitives: GltfPrimitive[] = []
  const walk = (i: number, parent: Mat4, above: number[]) => {
    const node = nodes[i]
    if (!node) throw new Error(`${path}: no node ${i}`)
    if (above.includes(i)) throw new Error(`${path}: node ${i} is its own ancestor`)
    const matrix = multiply(parent, local(node))
    const mesh = doc.meshes?.[node.mesh]
    if (node.skin !== undefined) unread.push(`skin on node ${i}`)
    if (mesh) {
      for (const [k, p] of (mesh.primitives as Json[]).entries()) {
        const mode = p.mode ?? 4
        if (mode !== 4)
          throw new Error(
            `${path}: mesh ${node.mesh} primitive ${k} is ${MODES[mode] ?? `mode ${mode}`}; only TRIANGLES are read`,
          )
        if (p.attributes?.POSITION === undefined)
          throw new Error(`${path}: mesh ${node.mesh} primitive ${k} has no POSITION`)
        if (p.targets?.length) unread.push(`morph targets on mesh ${node.mesh} primitive ${k}`)
        const positions = accessor(p.attributes.POSITION, Float32Array, 'POSITION')
        const count = positions.length / 3
        const at = `mesh ${node.mesh} primitive ${k}`
        primitives.push({
          name: node.name ?? mesh.name ?? `node-${i}`,
          node: i,
          mesh: node.mesh,
          primitive: k,
          count,
          positions,
          ...(p.attributes.NORMAL === undefined
            ? {}
            : { normals: accessor(p.attributes.NORMAL, Float32Array, `${at} NORMAL`) }),
          ...(p.attributes.TEXCOORD_0 === undefined
            ? {}
            : { uvs: accessor(p.attributes.TEXCOORD_0, Float32Array, `${at} TEXCOORD_0`) }),
          indices:
            p.indices === undefined
              ? Uint32Array.from({ length: count }, (_, n) => n)
              : accessor(p.indices, Uint32Array, `${at} indices`),
          matrix,
          material: material(p.material),
        })
      }
    }
    for (const c of node.children ?? []) walk(c, matrix, [...above, i])
  }
  for (const r of roots) walk(r, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], [])
  return { primitives, unread: [...new Set(unread)] }
}

/** Reads a model of the project: `await loadGltf(host, 'assets/chair.glb')`. */
export const loadGltf = (host: { io: { read(path: string): Promise<Uint8Array> } }, path: string) =>
  readGltf((p) => host.io.read(p), path)
