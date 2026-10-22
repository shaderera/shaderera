import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Probe } from '../cli/ffmpeg.ts'
import type { Job } from '../project/jobs.ts'
import { hdr10Changes, jobOfFile, pictureDifferences, remuxArgs, samplesOf } from './reexport.ts'

const job = (o: Partial<Job> & { name: string }): Job =>
  ({
    id: o.name,
    revision: 'r1',
    host: 'node',
    params: {},
    seed: 1,
    camera: 'authored',
    output: { width: 8, height: 8, fps: 10, from: 0, to: 1 },
    delivery: { format: 'mp4', quality: 'review', color: 'sdr-bt709' },
    ...o,
  }) as Job

test('the samples are the first frame, the last and about one every 10 s', () => {
  assert.deepEqual(samplesOf(10, 10), [0, 5, 9])
  assert.deepEqual(samplesOf(1, 10), [0])
  assert.deepEqual(samplesOf(300, 10), [0, 50, 150, 250, 299])
})

test("a delivered file's job is one of its revision with the same picture settings", () => {
  const a = job({ name: 'a' })
  const stems = job({ name: 's', delivery: { ...a.delivery, stems: true } })
  assert.deepEqual(pictureDifferences(a, stems), [], 'stems are sound')
  const master = job({ name: 'm', delivery: { ...a.delivery, quality: 'master' } })
  assert.match(pictureDifferences(a, master).join(), /^delivery/)
  assert.match(pictureDifferences(a, job({ name: 'v', variant: 'square' })).join(), /^variant/)

  const b = job({ name: 'b', revision: 'r2' })
  assert.equal(jobOfFile([a, b], b, 'a.mp4', 'r1'), a)
  assert.equal(jobOfFile([a, stems], stems, 's.mp4', 'r1'), stems, 'the job itself first')
  assert.throws(() => jobOfFile([a], master, 'a.mp4', 'r1'), /a\.mp4 is of job a, whose picture/)
  assert.throws(() => jobOfFile([b], b, 'x.mp4', 'r9'), /no job of that revision/)
})

test('a remux copies the video packets and writes the sound as a render does', () => {
  const o = {
    video: 'in.mp4',
    out: 'out.mp4',
    container: 'mp4',
    codec: 'h264' as const,
    audio: { inputs: ['-i', 'tone.wav'], graph: '[1:a]anull[aout]' },
    seconds: 2,
    revision: 'r1',
  }
  const mp4 = remuxArgs({ ...o, editList: false, timecode: '00:00:10:00' }).join(' ')
  assert.match(mp4, /-i in\.mp4 -i tone\.wav -filter_complex \S+ -map 0:v -map \[aout\] -c:v copy/)
  assert.match(mp4, /-c:a aac -b:a 192k -ar 48000 -ac 2/)
  assert.match(
    mp4,
    /-movflags \+faststart\+negative_cts_offsets\+use_metadata_tags -use_editlist 0/,
  )
  assert.match(mp4, /-timecode 00:00:10:00 -metadata shaderera_revision=r1 -f mp4 -t 2 out\.mp4$/)
  const mov = remuxArgs({ ...o, codec: 'prores-hq', container: 'mov' }).join(' ')
  assert.match(mov, /-c:a pcm_s24le .*-fflags \+bitexact/)
  const silent = remuxArgs({ ...o, audio: null }).join(' ')
  assert.doesNotMatch(silent, /-c:a|\[aout\]/)
})

test('a remux of an HDR10 file must keep its tags, display and light levels', () => {
  const display = {
    red: [0.708, 0.292],
    green: [0.17, 0.797],
    blue: [0.131, 0.046],
    white: [0.3127, 0.329],
    peak: 1000,
    min: 0.0001,
  } as const
  const light = { maxCLL: 813, maxFALL: 102 }
  const file = (hdr10?: NonNullable<Probe['video']>['hdr10']): Probe => ({
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    bytes: 1,
    duration: 1,
    bitrate: 1,
    editList: true,
    video: {
      codec: 'hevc',
      pixFmt: 'yuv420p10le',
      width: 8,
      height: 8,
      fps: 10,
      color: { matrix: 'bt2020nc', primaries: 'bt2020', transfer: 'smpte2084', range: 'tv' },
      ...(hdr10 ? { hdr10 } : {}),
    },
  })
  const hdr = file({
    codecTag: 'hvc1',
    chroma: 'topleft',
    mastering: display,
    light,
    sei: { mastering: display, light },
  })
  assert.deepEqual(hdr10Changes(hdr, hdr), [])
  assert.deepEqual(hdr10Changes(file(), file()), [], 'an SDR file has none to keep')
  const lost = file({
    codecTag: 'hvc1',
    chroma: 'topleft',
    mastering: display,
    sei: { mastering: display, light },
  })
  assert.match(hdr10Changes(hdr, lost).join(), /^light \{"maxCLL":813,"maxFALL":102\}, not null$/)
  const other = file({
    codecTag: 'hev1',
    chroma: 'topleft',
    mastering: display,
    light: { maxCLL: 1000, maxFALL: 102 },
    sei: { mastering: display, light },
  })
  assert.deepEqual(
    hdr10Changes(hdr, other).map((d) => d.split(' ')[0]),
    ['codecTag', 'light'],
  )
})
