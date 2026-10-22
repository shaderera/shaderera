import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual, parseArgs } from 'node:util'
import { frameTimes } from '@shaderera/core'
import { toSrt, toVtt, windowCaptions } from '@shaderera/core/host'
import { hdr10Changes, jobOfFile, remux, remuxArgs, sameFrames } from '../deliver/reexport.ts'
import { outside } from '../node/inside.ts'
import { findProject } from '../node/project.ts'
import { listJobs, openJob, readJob, videoOptionsOf } from '../project/jobs.ts'
import { childOptions, common } from './args.ts'
import {
  containerOf,
  loudnessLine,
  measureLoudness,
  probe,
  probeLine,
  requireFfmpeg,
  requireFrames,
} from './ffmpeg.ts'
import { openMix } from './mix.ts'
import { fileTimecode, prerollOf } from './preroll.ts'
import { extensionOf } from './render.ts'

/**
 * `shaderera reexport audio --job <name> [--onto file] [--out file] [--no-audio] [--loudness=LUFS]`:
 * the job's mix, made again, on a delivered file's own video packets (`-c:v copy`): no frame is
 * rendered or encoded. The file's job is found by its revision tag among the project's jobs; when
 * its revision or params are not this job's, a sample of frames is rendered in both and must match.
 * An HDR10 file keeps its colour tags, mastering display and light levels (boxes and SEI) as they
 * were: the light its encode measured, not measured again (hdr10Changes).
 *
 * `shaderera reexport captions --job <name> [--out file]`: the job's SRT and WebVTT sidecars,
 * written beside `--out` as render writes them, without rendering.
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const { values: v, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      ...common,
      job: { type: 'string' },
      onto: { type: 'string' },
      out: { type: 'string' },
      'no-audio': { type: 'boolean' },
      loudness: { type: 'string' },
    },
  })
  const [what, ...more] = positionals
  if ((what !== 'audio' && what !== 'captions') || more.length > 0 || typeof v.job !== 'string')
    throw new Error(
      'reexport takes what to export again and the job: shaderera reexport audio|captions --job <name>.',
    )
  if (what === 'captions' && (v.onto ?? v['no-audio'] ?? v.loudness) !== undefined)
    throw new Error('--onto, --no-audio and --loudness are for reexport audio.')
  const loudness = v.loudness === undefined ? undefined : Number(v.loudness)
  if (loudness !== undefined && !Number.isFinite(loudness))
    throw new Error('--loudness needs LUFS, such as -23 or -14.')
  const { root } = await findProject(typeof v.root === 'string' ? v.root : process.cwd())
  const job = readJob(root, v.job)
  if (job.delivery.format === 'png')
    throw new Error(
      `Job ${job.name} is a png handoff, whose delivery.json records its sound and captions: render it with render --job.`,
    )
  const video = videoOptionsOf(job.delivery)
  // The job's own file, as render --job writes it.
  const own = join(root, 'out', `${job.name}${extensionOf(video.codec)}`)
  const out = typeof v.out === 'string' ? resolve(v.out) : own
  // Anywhere else in the project, the file would be saved into every later revision.
  if (!outside(root, out) && outside(join(root, 'out'), out))
    throw new Error(
      `${out} is in the project but not in out/: write to out/ or outside the project.`,
    )
  const base = out.replace(/\.[^./\\]+$/, '')
  if (what === 'captions') {
    const { project, child } = await openJob(root, job, childOptions(v))
    try {
      const cues = await child.captions()
      if (!cues) throw new Error(`Job ${job.name}'s source has no captions().`)
      const head = job.output.from - prerollOf(project.manifest).seconds
      const inWindow = windowCaptions(cues, head, job.output.to)
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(`${base}.srt`, toSrt(inWindow))
      writeFileSync(`${base}.vtt`, toVtt(inWindow))
      console.log(`${base}.srt\n${base}.vtt\n${inWindow.length} captions, no frames rendered`)
      return 0
    } finally {
      await child.close()
    }
  }

  requireFfmpeg()
  const onto = typeof v.onto === 'string' ? resolve(v.onto) : own
  const was = probe(onto)
  if (!was.video || !was.revision)
    throw new Error(
      `${onto} is not a file Shaderera rendered (no video, or no shaderera_revision tag).`,
    )
  const of = jobOfFile(listJobs(root), job, onto, was.revision)
  const { project, child } = await openJob(root, job, childOptions(v))
  const partial = `${out}.${process.pid}.partial`
  let mix: ReturnType<typeof openMix> | undefined
  try {
    const { manifest } = project
    const preroll = prerollOf(manifest)
    const { from, to } = job.output
    const frames = preroll.frames + frameTimes(manifest.fps, from, to).length
    const { width, height } = manifest
    if (was.video.frames !== frames || was.video.width !== width || was.video.height !== height)
      throw new Error(
        `${onto} is ${was.video.width}×${was.video.height}, ${was.video.frames ?? 'unknown'} frames; job ${job.name} is ${width}×${height}, ${frames} frames: render the job instead.`,
      )
    // Another revision or other params may draw another picture: a sample of frames must match.
    if (of.revision !== job.revision || !isDeepStrictEqual(of.params, job.params)) {
      const earlier = await openJob(root, of, childOptions(v))
      try {
        const differ = await sameFrames(earlier.child, child, job)
        if (differ.length > 0)
          throw new Error(
            `Job ${job.name} draws other frames than job ${of.name}, which made ${onto}, at t ${differ.map((t) => `${Number(t.toFixed(4))} s`).join(', ')}: render job ${job.name} instead.`,
          )
      } finally {
        await earlier.child.close()
      }
    }
    const head = from - preroll.seconds
    mix = openMix(
      project.root,
      v['no-audio'] === true ? [] : ((await child.audio()) ?? []),
      { from: head, to },
      { loudness },
    )
    mkdirSync(dirname(out), { recursive: true })
    const prores = video.codec !== 'h264'
    remux(
      remuxArgs({
        video: onto,
        out: partial,
        container: containerOf(out, video.codec),
        codec: video.codec,
        // AAC's priming, cut from the mix when the mp4 has no edit list to skip it (as render does).
        audio: mix.encode(!prores && video.editList === false),
        seconds: to - head,
        revision: job.revision,
        ...(video.editList === false ? { editList: false } : {}),
        ...(manifest.timecode || preroll.frames
          ? { timecode: fileTimecode(manifest, from, preroll.frames) }
          : {}),
      }),
    )
    const probed = probe(partial)
    requireFrames(out, probed, frames)
    // An HDR10 file keeps the display and the light its frames (or its plan's chunks) declared.
    const changed = hdr10Changes(was, probed)
    if (changed.length > 0)
      throw new Error(
        `${out} lost the HDR10 signalling of ${onto} in the remux (${changed.join('; ')}): render job ${job.name} instead.`,
      )
    const measured = mix.clips.length > 0 ? measureLoudness(partial) : null
    renameSync(partial, out)
    const stems = job.delivery.stems && mix.clips.length > 0 ? mix.stems(`${base}.stems`) : []
    console.log(`${out}\nthe video of ${onto} (job ${of.name}), no frames rendered or encoded`)
    console.log(`file: ${probeLine(probed)}`)
    console.log(`revision: ${job.revision}`)
    for (const f of stems) console.log(f)
    if (measured)
      console.log(
        `audio: ${loudnessLine(measured)}${mix.level ? ` (gain ${mix.level.gainDb.toFixed(2)} dB for ${loudness} LUFS)` : ''}`,
      )
    else console.log('audio: none')
    return 0
  } catch (error) {
    rmSync(partial, { force: true })
    throw error
  } finally {
    mix?.close()
    await child.close()
  }
}
