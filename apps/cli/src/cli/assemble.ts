import { join, resolve } from 'node:path'
import { checkChunks, chunkFrames, readPlan } from '../deliver/chunks.ts'
import { findProject } from '../node/project.ts'
import { retriesOf } from '../node/retry.ts'
import { openJob, readJob, videoOptionsOf } from '../project/jobs.ts'
import { childOptions, parse } from './args.ts'
import { loudnessLine, probeLine } from './ffmpeg.ts'
import { exportVideo, extensionOf } from './render.ts'

/**
 * `shaderera assemble --plan <dir> [--out file] [--mixed-hosts] [--no-audio] [--loudness=LUFS]
 * [--retries n]`: encodes a plan's rendered chunks once, in order, with the whole window's sound, captions and
 * preroll, as `render --job` would on one machine. Refuses a chunk that is missing or changed, and
 * chunks from different kinds of host unless --mixed-hosts. --retries: an encode that fails
 * transiently (a stall, out of memory, a crash) is done again from the first chunk, up to n times.
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const v = parse(argv, {
    plan: { type: 'string' },
    out: { type: 'string' },
    'mixed-hosts': { type: 'boolean' },
    'no-audio': { type: 'boolean' },
    loudness: { type: 'string' },
    retries: { type: 'string' },
  })
  const retries = retriesOf(v.retries)
  if (typeof v.plan !== 'string') throw new Error('assemble needs --plan <dir>.')
  const dir = resolve(v.plan)
  const plan = readPlan(dir)
  const { root } = await findProject(typeof v.root === 'string' ? v.root : process.cwd())
  const job = readJob(root, plan.job)
  if (job.id !== plan.jobId)
    throw new Error(
      `Job ${job.name} is not the one this plan was made from (${plan.jobId.slice(0, 8)}).`,
    )
  const records = checkChunks(plan, dir, v['mixed-hosts'] === true)
  const { project, child } = await openJob(root, job, childOptions(v))
  try {
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
      revision: job.revision,
      retries,
      audio: v['no-audio'] !== true,
      ...(loudness === undefined ? {} : { loudness }),
      frames: {
        input: plan.input,
        count: plan.chunks.reduce((n, c) => n + c.frames, 0),
        read: () => chunkFrames(plan, dir),
      },
    })
    console.log(`${done.out}\n${done.frames} frames from ${records.length} chunks`)
    console.log(`file: ${probeLine(done.probe)}`)
    if (done.loudness) console.log(`audio: ${loudnessLine(done.loudness)}`)
    return 0
  } finally {
    await child.close()
  }
}
