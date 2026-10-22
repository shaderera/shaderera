import { join, resolve } from 'node:path'
import { checkChunks, chunkFrames, isHdr, mostLight, readPlan } from '../deliver/chunks.ts'
import { assembledInput, assembledJob } from '../deliver/reexport.ts'
import { findProject } from '../node/project.ts'
import { openJob, videoOptionsOf } from '../project/jobs.ts'
import { childOptions, parse } from './args.ts'
import { loudnessLine, probeLine } from './ffmpeg.ts'
import { exportVideo, extensionOf, lightLine } from './render.ts'

/**
 * `shaderera assemble --plan <dir> [--out file] [--mixed-hosts] [--no-audio] [--loudness=LUFS]
 * [--job name] [--crf n]`: encodes a plan's rendered chunks once, in order, with the whole window's
 * sound, captions and preroll, as `render --job` would on one machine. Refuses a chunk that is
 * missing or changed, and chunks from different kinds of host unless --mixed-hosts. --job: another
 * delivery of the plan's job from the same chunks (assembledJob). An hdr10 plan's file declares the
 * most light any of its chunks measured (decision 0023).
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const v = parse(argv, {
    plan: { type: 'string' },
    out: { type: 'string' },
    'mixed-hosts': { type: 'boolean' },
    'no-audio': { type: 'boolean' },
    loudness: { type: 'string' },
    job: { type: 'string' },
    crf: { type: 'string' },
  })
  if (typeof v.plan !== 'string') throw new Error('assemble needs --plan <dir>.')
  const dir = resolve(v.plan)
  const plan = readPlan(dir)
  const { root } = await findProject(typeof v.root === 'string' ? v.root : process.cwd())
  const job = assembledJob(root, plan, typeof v.job === 'string' ? v.job : undefined)
  const records = checkChunks(plan, dir, v['mixed-hosts'] === true)
  const { project, child } = await openJob(root, job, childOptions(v))
  try {
    if (job.id !== plan.jobId) assembledInput(plan, job, child)
    const video = videoOptionsOf(job.delivery)
    const loudness = v.loudness === undefined ? undefined : Number(v.loudness)
    const done = await exportVideo(project, child, {
      ...video,
      from: job.output.from,
      to: job.output.to,
      out:
        typeof v.out === 'string'
          ? resolve(v.out)
          : join(root, 'out', `${job.name}${extensionOf(video.codec)}`),
      quality: job.delivery.quality,
      ...(v.crf === undefined ? {} : { crf: Number(v.crf) }),
      revision: job.revision,
      audio: v['no-audio'] !== true,
      ...(loudness === undefined ? {} : { loudness }),
      frames: {
        input: plan.input,
        count: plan.chunks.reduce((n, c) => n + c.frames, 0),
        read: () => chunkFrames(plan, dir),
        ...(isHdr(plan.input)
          ? { light: mostLight(records.flatMap((r) => (r.light ? [r.light] : []))) }
          : {}),
      },
    })
    console.log(`${done.out}\n${done.frames} frames from ${records.length} chunks`)
    console.log(`file: ${probeLine(done.probe)}`)
    if (done.light) console.log(`light: ${lightLine(done.light)}`)
    if (done.loudness) console.log(`audio: ${loudnessLine(done.loudness)}`)
    return 0
  } finally {
    await child.close()
  }
}
