import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { frameTimes } from '@shaderera/core'
import { type Job, LOCKS, openJob } from '../project/jobs.ts'
import { readObject, readRevision, SECRET } from '../project/revisions.ts'
import { environment } from './environment.ts'

/** The install command for a revision's lock file. */
const installCommand = (lock: string | undefined): string[] =>
  lock === 'package-lock.json'
    ? ['npm', 'ci']
    : lock === 'pnpm-lock.yaml'
      ? ['pnpm', 'install', '--frozen-lockfile']
      : lock === 'yarn.lock'
        ? ['yarn', 'install', '--frozen-lockfile']
        : ['npm', 'install']

/**
 * A frozen handoff of a job in `out/handoff/<job>/`: the revision's files as the working tree
 * (never node_modules, out or a secret: project/revisions.ts `SECRET`), and a `versions/` store
 * holding only that revision and the job, so `shaderera render --job <name>` renders the same
 * thing there. With REPRODUCE.md: the commands, the environment measured now, the lock file's
 * state, the packages the job executes and the assets' hashes.
 *
 * `reproducible` says whether a clean install elsewhere can give the job's packages: it needs a
 * lock file and no dependency that only exists here (`workspace:`, `file:`, `link:`). When it is
 * false, `reasons` says why and REPRODUCE.md says the handoff is not a production handoff.
 */
export const writeHandoff = (
  root: string,
  job: Job,
  dir = join(root, 'out', 'handoff', job.name),
) => {
  const revision = readRevision(root, job.revision)
  // A revision saved before scan left secrets out may still hold one.
  const secrets = Object.keys(revision.files).filter((p) => SECRET.test(p.split('/').at(-1) ?? ''))
  if (secrets.length > 0)
    throw new Error(
      `Revision ${revision.id} holds ${secrets.join(', ')}, which a handoff never carries: freeze the job again (shaderera job --name ${job.name} --replace), which saves a revision without them.`,
    )
  rmSync(dir, { recursive: true, force: true })
  const put = (path: string, data: Buffer | string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), data)
  }
  for (const [path, hash] of Object.entries(revision.files)) {
    const data = readObject(root, hash)
    put(path, data)
    put(`versions/objects/${hash}`, data)
  }
  put(`versions/revisions/${revision.id}.json`, `${JSON.stringify(revision, null, 1)}\n`)
  put(`versions/jobs/${job.name}.json`, `${JSON.stringify(job, null, 1)}\n`)
  const env = environment()
  const lock = LOCKS.find((l) => revision.files[l])
  const pkg = revision.files['package.json']
    ? (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        dependencies?: { [k: string]: string }
        devDependencies?: { [k: string]: string }
      })
    : undefined
  const specs = Object.entries({ ...pkg?.dependencies, ...pkg?.devDependencies })
  const workspace = specs.filter(([, v]) => v.startsWith('workspace:')).map(([k]) => k)
  const local = specs.filter(([, v]) => /^(file|link):/.test(v)).map(([k]) => k)
  const install = installCommand(lock).join(' ')
  const reasons = [
    ...(pkg ? [] : ['the revision has no package.json']),
    ...(lock ? [] : ['the revision has no lock file, so an install resolves version ranges anew']),
    ...(workspace.length
      ? [`${workspace.join(', ')} ${workspace.length > 1 ? 'are' : 'is'} workspace:*`]
      : []),
    ...(local.length
      ? [`${local.join(', ')} ${local.length > 1 ? 'are' : 'is'} a local path (file: or link:)`]
      : []),
  ]
  const packages = Object.entries(job.inputs.packages)
  const md = [
    `# Reproduce ${job.name}`,
    '',
    `Job \`${job.name}\` (id ${job.id}) renders revision \`${job.revision}\`${job.variant ? `, variant \`${job.variant}\`` : ''}, seed ${job.seed}, ` +
      `${job.output.width}×${job.output.height} at ${job.output.fps} fps, ${job.output.from}–${job.output.to} s, ` +
      `delivery ${job.delivery.format} / ${job.delivery.quality} / ${job.delivery.color}.`,
    '',
    reasons.length === 0
      ? '**Reproducible from a clean install:** yes. The lock file pins every package, and `render --job` refuses to render if the installed packages differ from the ones listed below.'
      : `**Reproducible from a clean install: no.** ${reasons.map((r) => `${r[0]?.toUpperCase()}${r.slice(1)}`).join('. ')}. This is not a production handoff: it renders only against an installation whose packages match the ones listed below (\`render --job\` checks them and refuses otherwise).`,
    '',
    '## Commands',
    '',
    '```sh',
    ...(pkg
      ? [install]
      : ['# no package.json in this revision: install shaderera yourself (npm i -D shaderera)']),
    `npx shaderera render --job ${job.name}`,
    `# a source the sandbox refuses (Node APIs beyond io) needs: npx shaderera render --job ${job.name} --trusted`,
    '```',
    '',
    job.delivery.format === 'png'
      ? `Output: \`out/${job.name}/\` (frames/, audio.wav when the source has audio, delivery.json with a sha256 per frame).`
      : `Output: \`out/${job.name}.mp4\`.`,
    '',
    '## Dependencies',
    '',
    lock
      ? `Lock file: \`${lock}\` (sha256 ${job.inputs.lock ?? 'not recorded'}), part of the revision.`
      : 'No lock file in this revision: `npm install` resolves the version ranges in package.json, so a later install can differ. Commit a lock file to pin them.',
    ...(workspace.length
      ? [
          '',
          `\`${workspace.join('`, `')}\` ${workspace.length > 1 ? 'are' : 'is'} \`workspace:*\` (the Shaderera monorepo). Outside it, set ${workspace.length > 1 ? 'them' : 'it'} to the published version (Shaderera ${job.inputs.shaderera}) before installing.`,
        ]
      : []),
    '',
    `The job executes these installed packages (sha256 of each package's files), and renders with Shaderera ${job.inputs.shaderera}:`,
    '',
    ...(packages.length ? packages.map(([k, h]) => `- \`${k}\` ${h}`) : ['- (none)']),
    '',
    '## Environment measured at handoff',
    '',
    `- OS: ${env.os}`,
    `- GPU: ${env.gpu}`,
    `- Node: ${env.node}`,
    `- ffmpeg: ${env.ffmpeg}`,
    `- Shaderera: ${env.shaderera} (job created with ${job.inputs.shaderera})`,
    '',
    'Frames are compared by sha256 of the composited RGBA. A GPU source can differ across GPUs or',
    'drivers; Canvas2D and CPU sources should not.',
    '',
    '## Assets',
    '',
    revision.files['ASSETS.md']
      ? 'Provenance and licences: `ASSETS.md`. Hashes as frozen in the job:'
      : 'No ASSETS.md in this revision. Hashes as frozen in the job:',
    '',
    ...(Object.keys(job.inputs.assets).length
      ? Object.entries(job.inputs.assets).map(([p, h]) => `- \`${p}\` ${h}`)
      : ['- (none)']),
    '',
    ...bakesSection(root, job, revision.files['shaderera.json']),
  ].join('\n')
  put('REPRODUCE.md', md)
  return { dir, environment: env, reproducible: reasons.length === 0, reasons }
}

/**
 * What REPRODUCE.md says of the bakes a job reads. Their frames are not in the handoff (they may be
 * gigabytes, on another drive): where they must be, what makes them, and that `render --job`
 * checks every frame against the sha256 the job pinned.
 */
const bakesSection = (root: string, job: Job, manifestHash: string | undefined): string[] => {
  const bakes = Object.entries(job.inputs.bakes ?? {})
  if (bakes.length === 0) return []
  const declared: { [name: string]: { command?: string } } = manifestHash
    ? (JSON.parse(readObject(root, manifestHash).toString('utf8')).bakes ?? {})
    : {}
  return [
    '## Bakes',
    '',
    'Frames made outside the host, which the source reads. They are not in this handoff: put them',
    'where the job read them, or make them again from this revision with `npx shaderera bake <name>`.',
    `\`render --job\` checks every frame against the sha256 the job pinned (\`inputs.bakes\` in`,
    `\`versions/jobs/${job.name}.json\`) and refuses a missing or different one, so a bake that does`,
    'not make the same bytes again cannot render this job.',
    '',
    ...bakes.map(
      ([name, pin]) =>
        `- \`${name}\`: ${pin.frames.length} frames in \`${pin.dir}\`, made by \`${declared[name]?.command ?? '?'}\` (inputs ${pin.inputs})`,
    ),
    '',
  ]
}

const hashes = async (
  root: string,
  job: Job,
  times: readonly number[],
  o: { trusted?: boolean; timeoutMs?: number },
) => {
  const { child } = await openJob(root, job, o)
  try {
    const out: string[] = []
    for (const t of times)
      out.push(
        createHash('sha256')
          .update((await child.render(t, 'final')).pixels)
          .digest('hex'),
      )
    return out
  } finally {
    await child.close()
  }
}

/**
 * Runs a handoff in a fresh temp folder, opens the job there from its own `versions/` and compares
 * the sha256 of a few frames with the same frames rendered from the project.
 *
 * `install: 'link'` (the default) links the project's own node_modules in: it shows the handoff
 * is complete and relocatable against this installation, not that a clean install reproduces it.
 * `install: 'clean'` runs the lock file's install command (`npm ci`, …) in the fresh folder
 * instead, and the job's package check then compares what that install gave with what the job
 * froze: the test for handing the job to someone else. It refuses a handoff that is not
 * reproducible from a clean install (see writeHandoff).
 */
export const verifyHandoff = async (
  root: string,
  job: Job,
  dir: string,
  o: { trusted?: boolean; timeoutMs?: number; samples?: number; install?: 'link' | 'clean' } = {},
) => {
  const samples = o.samples ?? 5
  const install = o.install ?? 'link'
  const fresh = mkdtempSync(join(tmpdir(), `shaderera-handoff-${job.name}-`))
  try {
    cpSync(dir, fresh, { recursive: true })
    if (install === 'clean') {
      const lock = LOCKS.find((l) => existsSync(join(fresh, l)))
      if (!lock)
        throw new Error('A clean-install check needs a lock file in the revision; this has none.')
      const [command, ...args] = installCommand(lock) as [string, ...string[]]
      const r = spawnSync(command, args, {
        cwd: fresh,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        timeout: 10 * 60_000,
      })
      if (r.status !== 0)
        throw new Error(
          `${command} ${args.join(' ')} failed in the fresh folder:\n${(r.stderr || r.stdout || String(r.error ?? '')).trim()}`,
        )
    } else if (existsSync(join(root, 'node_modules')))
      symlinkSync(join(root, 'node_modules'), join(fresh, 'node_modules'), 'junction')
    const all = frameTimes(job.output.fps, job.output.from, job.output.to)
    const times = [
      ...new Set(
        Array.from(
          { length: samples },
          (_, i) => all[Math.round((i * (all.length - 1)) / Math.max(1, samples - 1))] as number,
        ),
      ),
    ]
    const [original, reproduced] = [
      await hashes(root, job, times, o),
      await hashes(fresh, job, times, o),
    ]
    const frames = times.map((t, i) => ({
      t,
      original: original[i],
      reproduced: reproduced[i],
      same: original[i] === reproduced[i],
    }))
    return { folder: fresh, install, same: frames.every((f) => f.same), frames }
  } finally {
    rmSync(fresh, { recursive: true, force: true })
  }
}
