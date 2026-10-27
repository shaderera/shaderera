// PNG and JPEG decoded for `io.image` by one WASM module (ADR 0028): in the CLI's process for its
// hosts (node/stills.ts), and in the web player's worker and for `io.bake`'s `image(i)` in each host,
// so every host samples the same pixels: never a canvas or a browser's decoder.
import type { DecodedImage } from '@shaderera/core'
import { IMAGE_WASM } from './image-wasm.ts'

type Call = (at: number, len: number, maxSize: number) => number
type Exports = {
  memory: WebAssembly.Memory
  alloc: (len: number) => number
  decode: Call
  size: Call
}

let compiled: WebAssembly.Module | undefined
const decoder = () => {
  compiled ??= new WebAssembly.Module(Uint8Array.from(atob(IMAGE_WASM), (c) => c.charCodeAt(0)))
  // A fresh instance each call: a WASM memory only grows, so one kept would hold the largest
  // still decoded for as long as the host runs.
  return new WebAssembly.Instance(compiled).exports as unknown as Exports
}

/** The module's `decode` or `size` on a file's bytes: the result's width, height, bits and data. */
const call = (name: 'decode' | 'size', bytes: Uint8Array, path: string, maxSize?: number) => {
  // Up to the decoder's largest side, 65536, so the value reaches it unwrapped.
  if (maxSize !== undefined && !(Number.isInteger(maxSize) && maxSize >= 1 && maxSize <= 65536))
    throw new Error(`io.image ${path}: maxSize is a whole number of pixels, not ${maxSize}.`)
  const exports = decoder()
  const at = exports.alloc(bytes.length)
  new Uint8Array(exports.memory.buffer, at, bytes.length).set(bytes)
  const result = exports[name](at, bytes.length, maxSize ?? 0)
  // Read only after the call: it grows the memory, which detaches the buffer from before.
  const [ok, width, height, bits, data, len] = new Uint32Array(
    exports.memory.buffer,
    result,
    6,
  ) as unknown as number[]
  const out = exports.memory.buffer.slice(data as number, (data as number) + (len as number))
  if (!ok) {
    const why = new TextDecoder().decode(out)
    // 'not a PNG or JPEG' is file_size's and decode_file's own message (wasm/image/src/lib.rs).
    throw new Error(
      why === 'not a PNG or JPEG'
        ? `${path} is not a PNG or JPEG: convert it to PNG once (the plugin image-to-png).`
        : `${path} could not be decoded: ${why}.`,
    )
  }
  return {
    width: width as number,
    height: height as number,
    bits: bits === 16 ? 16 : 8,
    out,
  } as const
}

/**
 * Straight RGBA from a PNG or JPEG file's bytes, 8 bits a sample or 16 for a 16-bit PNG; `path`
 * names it in errors. `maxSize` shrinks the long side to it with the box filter (ADR 0028, 4–5);
 * a still within it, or no `maxSize`, keeps its size.
 */
export const decodeImage = (bytes: Uint8Array, path: string, maxSize?: number): DecodedImage => {
  const { out, ...size } = call('decode', bytes, path, maxSize)
  return { ...size, data: size.bits === 16 ? new Uint16Array(out) : new Uint8Array(out) }
}

/** The width, height and bits `decodeImage` gives, read from the file's headers alone. */
export const imageSize = (bytes: Uint8Array, path: string, maxSize?: number) => {
  const { out: _, ...size } = call('size', bytes, path, maxSize)
  return size
}
