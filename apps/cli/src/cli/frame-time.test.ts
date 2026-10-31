import assert from 'node:assert/strict'
import { test } from 'node:test'
import { frameTime, frameTimeHint, frameTimeLine } from './frame-time.ts'

test('a render whose own drawing takes each frame while the encoder waits gets the GPU footage hint', () => {
  // 100 frames in 4 s on one host: 40 ms a frame, 31 of them the host's render call (9 of those on
  // io.video), 7 the compositor, readback and hand-off.
  const t = frameTime({
    frames: 100,
    wallMs: 4000,
    writeMs: 40,
    hosts: [{ renders: 108, renderMs: 108 * 31, videoMs: 108 * 9, composeMs: 108 * 7 }],
  })
  assert.deepEqual(t, {
    frames: 100,
    hosts: 1,
    frameMs: 40,
    renderMs: 31,
    videoMs: 9,
    composeMs: 7,
    encoderMs: 0.4,
    encoderIdle: true,
    drawing: true,
    compositor: false,
  })
  assert.equal(
    frameTimeLine(t),
    'time: 40.0 ms a frame · on the host: drawing 22.0 ms, compositor and readback 7.0 ms, waiting on io.video 9.0 ms · encoder idle (it took each frame in 0.4 ms and waited for the next)',
  )
  assert.match(
    frameTimeHint(t) ?? '',
    /own drawing.*guides\/speed\.md, "Footage and stills on the GPU"/,
  )
})

test('a render whose compositor and readback take each frame names them, not the drawing', () => {
  // The 1080p dither film of #497: 8 ms a frame, the film's render call 1 ms, the rest on the host
  // composing, reading back and handing the frame over while the encoder waits.
  const t = frameTime({
    frames: 100,
    wallMs: 800,
    writeMs: 50,
    hosts: [{ renders: 100, renderMs: 100, videoMs: 0, composeMs: 600 }],
  })
  assert.equal(t.drawing, false)
  assert.equal(t.compositor, true)
  assert.equal(
    frameTimeLine(t),
    'time: 8.0 ms a frame · on the host: drawing 1.0 ms, compositor and readback 6.0 ms, waiting on io.video 0.0 ms · encoder idle (it took each frame in 0.5 ms and waited for the next)',
  )
  assert.match(frameTimeHint(t) ?? '', /compositor and readback take most of each frame/)
  assert.doesNotMatch(frameTimeHint(t) ?? '', /drawing/)
})

test('no hint when the encoder, io.video or other hosts set the pace', () => {
  const hosts = [{ renders: 100, renderMs: 3100, videoMs: 900, composeMs: 300 }]
  // Writes waited most of the time: the encoder is the slow part.
  const busy = frameTime({ frames: 100, wallMs: 4000, writeMs: 3000, hosts })
  assert.equal(busy.encoderIdle, false)
  assert.equal(busy.drawing, false)
  assert.equal(busy.compositor, false)
  assert.equal(frameTimeHint(busy), null)
  assert.match(frameTimeLine(busy), /encoder busy \(each frame waited 30\.0 ms for it\)$/)
  // Waiting on io.video is most of the render.
  const video = frameTime({
    frames: 100,
    wallMs: 4000,
    writeMs: 10,
    hosts: [{ renders: 100, renderMs: 3100, videoMs: 2500, composeMs: 300 }],
  })
  assert.equal(video.drawing, false)
  assert.equal(video.compositor, false)
  // Two hosts: the drawing and the compositor of one are each under half its share of the time.
  const two = frameTime({
    frames: 100,
    wallMs: 4000,
    writeMs: 10,
    hosts: [
      { renders: 50, renderMs: 200, videoMs: 0, composeMs: 1800 },
      { renders: 50, renderMs: 200, videoMs: 0, composeMs: 1800 },
    ],
  })
  assert.equal(two.renderMs, 4)
  assert.equal(two.composeMs, 36)
  assert.equal(two.drawing, false)
  assert.equal(two.compositor, false)
  assert.match(
    frameTimeLine(two),
    /· on each of 2 hosts: drawing 4\.0 ms, compositor and readback 36\.0 ms,/,
  )
  // Nothing rendered (frames rendered elsewhere): no host time to say.
  const none = frameTime({ frames: 0, wallMs: 0, writeMs: 0, hosts: [] })
  assert.equal(none.renderMs, 0)
  assert.equal(none.composeMs, 0)
  assert.equal(frameTimeHint(none), null)
})
