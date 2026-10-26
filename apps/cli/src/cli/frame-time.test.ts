import assert from 'node:assert/strict'
import { test } from 'node:test'
import { frameTime, frameTimeHint, frameTimeLine } from './frame-time.ts'

test('a render whose own drawing takes each frame while the encoder waits gets the GPU footage hint', () => {
  // 100 frames in 4 s on one host: 40 ms a frame, 31 of them the host's render, 9 of those on io.video.
  const t = frameTime({
    frames: 100,
    wallMs: 4000,
    writeMs: 40,
    hosts: [{ renders: 108, renderMs: 108 * 31, videoMs: 108 * 9 }],
  })
  assert.deepEqual(t, {
    frames: 100,
    hosts: 1,
    frameMs: 40,
    renderMs: 31,
    videoMs: 9,
    encoderMs: 0.4,
    encoderIdle: true,
    drawing: true,
  })
  assert.equal(
    frameTimeLine(t),
    'time: 40.0 ms a frame · host render 31.0 ms · waiting on io.video 9.0 ms · encoder idle (it took each frame in 0.4 ms and waited for the next)',
  )
  assert.match(
    frameTimeHint(t) ?? '',
    /own drawing.*AUTHORING\.md, "Footage and stills on the GPU"/,
  )
})

test('no hint when the encoder, io.video or other hosts set the pace', () => {
  const hosts = [{ renders: 100, renderMs: 3100, videoMs: 900 }]
  // Writes waited most of the time: the encoder is the slow part.
  const busy = frameTime({ frames: 100, wallMs: 4000, writeMs: 3000, hosts })
  assert.equal(busy.encoderIdle, false)
  assert.equal(busy.drawing, false)
  assert.equal(frameTimeHint(busy), null)
  assert.match(frameTimeLine(busy), /encoder busy \(each frame waited 30\.0 ms for it\)$/)
  // Waiting on io.video is most of the render.
  const video = frameTime({
    frames: 100,
    wallMs: 4000,
    writeMs: 10,
    hosts: [{ renders: 100, renderMs: 3100, videoMs: 2500 }],
  })
  assert.equal(video.drawing, false)
  // Two hosts: the drawing of one is half its share of the wall time.
  const two = frameTime({
    frames: 100,
    wallMs: 4000,
    writeMs: 10,
    hosts: [
      { renders: 50, renderMs: 200, videoMs: 0 },
      { renders: 50, renderMs: 200, videoMs: 0 },
    ],
  })
  assert.equal(two.renderMs, 4)
  assert.equal(two.drawing, false)
  // Nothing rendered (frames rendered elsewhere): no host time to say.
  const none = frameTime({ frames: 0, wallMs: 0, writeMs: 0, hosts: [] })
  assert.equal(none.renderMs, 0)
  assert.equal(frameTimeHint(none), null)
})
