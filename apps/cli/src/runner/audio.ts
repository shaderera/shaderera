// The film's audio() clips on their way out of the runner worker. Sound made in code
// (AudioClip.pcm) can be hundreds of MB for a long film, so its samples never go as text (#353):
// - To a page over Comlink (the studio page, a site's player): Float32Arrays whose buffers are
//   transferred, when the page asks for them with `audio('buffers')`. A page that does not ask
//   (shaderera.com's player before it learnt to) gets base64 float32, as before.
// - To the browser host: one HTTP body POSTed to the runner server, as frames go (decision 0007).
//   A DevTools message over 4 MiB closes Node's WebSocket to Chrome.
import type { SampledClip } from '@shaderera/core'
import * as Comlink from 'comlink'

/** How a page asks for the pcm: transferred Float32Arrays, or (by default) base64 float32. */
export type PcmForm = 'buffers' | undefined

/**
 * The clips as the worker answers a page. With 'buffers', each channel is a copy (the film may keep
 * its own samples for the next call) whose buffer is transferred, not cloned.
 */
export const toPage = (clips: readonly SampledClip[], form?: PcmForm): SampledClip[] => {
  if (form !== 'buffers') return clips.map(toBase64Pcm)
  const buffers: ArrayBuffer[] = []
  const out = clips.map((c) => {
    if (!c.pcm) return c
    const channels = c.pcm.channels.map((ch) => {
      const copy = ch.slice()
      buffers.push(copy.buffer)
      return copy
    })
    return { ...c, pcm: { sampleRate: c.pcm.sampleRate, channels } }
  })
  return Comlink.transfer(out, buffers)
}

/** A clip's samples as base64 float32, one string a channel: what pages read before 'buffers'. */
const toBase64Pcm = (c: SampledClip): SampledClip => {
  if (!c.pcm) return c
  const channels = c.pcm.channels.map((ch) => {
    const bytes = new Uint8Array(ch.buffer, ch.byteOffset, ch.byteLength)
    let s = ''
    for (let i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(s)
  })
  return { ...c, pcm: { sampleRate: c.pcm.sampleRate, channels: channels as never } }
}

/**
 * The clips as one body for the browser host: the byte length of a JSON header (uint32, little
 * endian), the header (the clips, each pcm channel as its sample count), zeros to a multiple of
 * 4 bytes, then every pcm channel's float32 samples in order.
 */
export const packClips = (clips: readonly SampledClip[]): Blob => {
  const samples: Float32Array[] = []
  const header = new TextEncoder().encode(
    JSON.stringify(
      clips.map((c) => {
        if (!c.pcm) return c
        samples.push(...c.pcm.channels)
        return {
          ...c,
          pcm: { sampleRate: c.pcm.sampleRate, channels: c.pcm.channels.map((ch) => ch.length) },
        }
      }),
    ),
  )
  const head = new Uint8Array(4 + Math.ceil(header.length / 4) * 4)
  new DataView(head.buffer).setUint32(0, header.length, true)
  head.set(header, 4)
  return new Blob([head, ...(samples as Float32Array<ArrayBuffer>[])])
}

/** packClips' body back as clips. */
export const unpackClips = (body: Uint8Array): SampledClip[] => {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const length = view.getUint32(0, true)
  const clips = JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + length))) as SampledClip[]
  let at = 4 + Math.ceil(length / 4) * 4
  return clips.map((c) => {
    if (!c.pcm) return c
    const channels = (c.pcm.channels as unknown as number[]).map((n) => {
      // A copy: the body (a Node Buffer, say) need not be aligned for a Float32Array over it.
      const ch = new Float32Array(n)
      new Uint8Array(ch.buffer).set(body.subarray(at, at + n * 4))
      at += n * 4
      return ch
    })
    return { ...c, pcm: { sampleRate: c.pcm.sampleRate, channels } }
  })
}
