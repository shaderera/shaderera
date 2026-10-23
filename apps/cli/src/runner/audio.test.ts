import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AudioClip, SampledClip } from '@shaderera/core'
import { sampleClips } from '@shaderera/core/host'
import * as Comlink from 'comlink'
import { packClips, toPage, unpackClips } from './audio.ts'

/** A minute of stereo made in code at 48 kHz (23 MB), as a long film's music bed (#353). */
const RATE = 48000
const bed = () => {
  const n = 60 * RATE
  const left = new Float32Array(n).map((_, i) => Math.sin(i / 10) / 4)
  const right = new Float32Array(n).map((_, i) => Math.cos(i / 7) / 4)
  return [left, right]
}
const film = (): AudioClip[] => [
  { src: 'audio/voice.wav', at: 1, group: 'dialogue' },
  { pcm: { sampleRate: RATE, channels: bed() }, at: 0, gain: (t) => Math.min(1, t) },
]

/**
 * The runner worker's `audio` as a page calls it over Comlink (the studio, a site's player): the
 * port's messages are recorded, with what each transfers.
 */
const overPort = (source: () => AudioClip[]) => {
  const { port1, port2 } = new MessageChannel()
  const sent: { message: unknown; transfer: Transferable[] }[] = []
  const post = port1.postMessage.bind(port1)
  port1.postMessage = ((message: unknown, transfer: Transferable[] = []) => {
    sent.push({ message, transfer })
    post(message, transfer)
  }) as typeof port1.postMessage
  Comlink.expose(
    { audio: (pcm?: 'buffers') => toPage(sampleClips(source(), 70), pcm) },
    port1 as never,
  )
  const page = Comlink.wrap<{ audio(pcm?: 'buffers'): SampledClip[] }>(port2 as never)
  const close = () => {
    page[Comlink.releaseProxy]()
    port1.close()
    port2.close()
  }
  return { page, sent, close }
}

/** Every string in a structured-cloneable value, however deep. */
const strings = (v: unknown): string[] =>
  typeof v === 'string'
    ? [v]
    : v && typeof v === 'object' && !ArrayBuffer.isView(v)
      ? Object.values(v).flatMap(strings)
      : []

test('a page that asks for buffers gets the pcm as Float32Arrays, transferred, never base64', async (t) => {
  const { page, sent, close } = overPort(film)
  t.after(close)
  const clips = await page.audio('buffers')
  const want = bed()
  const pcm = clips[1]?.pcm
  assert.ok(pcm)
  assert.equal(pcm.sampleRate, RATE)
  assert.equal(pcm.channels.length, 2)
  for (const [i, ch] of pcm.channels.entries()) {
    assert.ok(ch instanceof Float32Array)
    assert.deepEqual(ch, want[i])
  }
  assert.deepEqual(clips[0], { src: 'audio/voice.wav', at: 1, group: 'dialogue' })
  // The answer crossed the port holding ArrayBuffers in its transfer list, one per channel, and
  // no string the size of a channel.
  const answer = sent.at(-1)
  assert.ok(answer)
  const buffers = answer.transfer.filter((x) => x instanceof ArrayBuffer)
  assert.equal(buffers.length, 2)
  assert.equal(
    buffers.reduce((n, b) => n + (b as ArrayBuffer).byteLength, 0),
    0, // detached: moved to the page, not copied
  )
  assert.ok(Math.max(0, ...strings(answer.message).map((s) => s.length)) < 1000)
})

test("transferring leaves the film's own samples whole for the next call", async (t) => {
  const kept = film()
  const { page, close } = overPort(() => kept)
  t.after(close)
  const first = await page.audio('buffers')
  const second = await page.audio('buffers')
  assert.equal(kept[1]?.pcm?.channels[0]?.length, 60 * RATE)
  assert.deepEqual(second[1]?.pcm?.channels, first[1]?.pcm?.channels)
})

test('a page that does not ask gets base64 float32, as shaderera.com reads it today', async (t) => {
  const tone = Float32Array.from([0, 0.5, -0.5, 1])
  const { page, close } = overPort(() => [{ pcm: { sampleRate: 8000, channels: [tone] }, at: 0 }])
  t.after(close)
  const [clip] = await page.audio()
  const b64 = clip?.pcm?.channels[0] as unknown as string
  assert.equal(typeof b64, 'string')
  assert.deepEqual(new Float32Array(Uint8Array.from(Buffer.from(b64, 'base64')).buffer), tone)
})

test('the browser host gets the clips back whole from one body', async () => {
  const clips = sampleClips(film(), 3)
  const body = new Uint8Array(await packClips(clips).arrayBuffer())
  // The samples go as bytes: the body is the samples plus a short header.
  assert.ok(body.length < 2 * 60 * RATE * 4 + 64 * 1024, `${body.length} bytes`)
  assert.deepEqual(unpackClips(body), clips)
  // As the runner server hands it over: a Node Buffer, at an offset in a larger pool.
  const pooled = Buffer.concat([Buffer.from([1, 2, 3]), body]).subarray(3)
  assert.deepEqual(unpackClips(pooled), clips)
  assert.deepEqual(unpackClips(new Uint8Array(await packClips([]).arrayBuffer())), [])
})
