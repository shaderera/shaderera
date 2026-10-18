import { existsSync } from 'node:fs'
import { COMMANDS as PLUGIN, usage as pluginUsage } from '../registry/cli.ts'
import { EXIT, errorFinding, findings, found } from './findings.ts'

const usage = `Usage: shaderera <command> [--root <dir>] [--variant <name>] [--trusted] [--timeout <s>] [options]

Commands:
  inspect <t> [--path a.b] [--json]          print the source's state at t
  check [--times 50] [--seed 1]              render each t twice in two orders and compare
  still <t>... [--every s] [--sheet] [--diff] [--compare variant] [--out dir] [--json]   stills of any moment, and a contact sheet
  render [--job name] [--from s] [--to s] [--out file] [--format mp4|prores-hq|prores-4444] [--crf 18] [--bitrate r | --maxrate r] [--no-edit-list] [--stems] [--progress] [--no-audio] [--loudness=LUFS]   export an mp4 or a ProRes mov (a png job: frames + audio.wav + delivery.json)
  deliver [--variants main,a,b] [--locales en,th] [--format f] [--png] [--master] [--bitrate r | --maxrate r] [--no-edit-list] [--stems] [--bits 16] [--no-audio] [--loudness=LUFS] [--name batch] [--job j]... [--replace]   campaign batch into out/deliveries/<batch>/
  plan --job j [--chunks 4] [--out dir]        split a job into chunks any machine renders (render --job j --chunk i)
  assemble --plan dir [--out file]           encode a plan's chunks once, with the sound
  handoff <job> [--verify] [--clean-install]   frozen project + job + REPRODUCE.md in out/handoff/<job>/
  review [--out dir] [--requirements file] [--quick] [--json]   frames, a contact sheet and technical checks
  bake [name...]                             run a bake's command and stamp the frames it made
  doctor [--json]                            what this machine and project have and lack (ffmpeg, encoders, Chrome, Dawn, GPU)
  mcp                                        serve the CLI as MCP tools over stdio

Versions and jobs:
  save [--label text]                        save the project as a revision
  versions [--json]                          saved revisions, restores, undos and jobs
  undo                                       back to the previous revision
  restore <revision>                         make the project that revision
  diff <a> [<b>] [--stat]                    what changed between revisions (or now)
  job [--variant v] [--params json] [--revision id] [--name n] [--format f] [--png] [--master] [--bits 16] [--stems]   freeze a render job

shaderera.com (or --to <origin>, else SHADERERA_SITE):
  login --token <token> [--to origin]        keep the token share sends to that site
  share [--film id] [--title t] [--yes] [--to origin] [--json]   send the project's files as a new film or version
  fork <film|url>[@version] [dir] [--to origin] [--json]          copy a published version into a new folder

${pluginUsage}

check, inspect, still, render and review take --param k=v (repeatable): a param over the defaults.

Stills: still (out/stills/). A review with technical checks: review (out/review/).`

const commands = [
  'inspect',
  'check',
  'still',
  'render',
  'review',
  'deliver',
  'handoff',
  'plan',
  'assemble',
  'bake',
  'doctor',
  'mcp',
  'save',
  'versions',
  'undo',
  'restore',
  'diff',
  'job',
  'login',
  'share',
  'fork',
  ...PLUGIN,
]

/** Commands whose own `--json` prints their result as JSON: the envelope carries it as `result`. */
const OWN_JSON = new Set([
  'inspect',
  'still',
  'review',
  'versions',
  'doctor',
  'search',
  'info',
  'share',
  'fork',
])
/** Commands that own stdout (a protocol): never wrapped. */
const STREAMS = new Set(['mcp'])

const main = async (argv: readonly string[]): Promise<number> => {
  const [command, ...rest] = argv
  const help = !command || ['--help', '-h'].some((h) => command === h || rest.includes(h))
  if (help || !commands.includes(command)) {
    console.log(usage)
    if (!help) found({ code: 'usage', severity: 'error', message: `Unknown command: ${command}` })
    return help ? EXIT.ok : EXIT.error
  }
  const url = new URL(`./${command}${import.meta.url.slice(-3)}`, import.meta.url)
  if (!existsSync(url)) {
    console.error(`shaderera ${command} is not available yet`)
    return EXIT.error
  }
  const module: { run(argv: readonly string[]): Promise<number> } = await import(url.href)
  return module.run(rest)
}

const argv = process.argv.slice(2)
const command = argv[0] ?? ''
/**
 * `--json` on any command but mcp: stdout is one envelope (`result/1`), what the command
 * printed goes into it (`result` when the command printed JSON, `log` otherwise), and the exit
 * code is the same as without it.
 */
const envelope = argv.includes('--json') && !STREAMS.has(command)
const log: string[] = []
if (envelope) console.log = (...parts: unknown[]) => log.push(parts.map(String).join(' '))
const given = envelope && !OWN_JSON.has(command) ? argv.filter((a) => a !== '--json') : argv
try {
  process.exitCode = await main(given)
} catch (e) {
  if (!envelope)
    console.error(process.env.SHADERERA_DEBUG ? e : `shaderera: ${(e as Error).message ?? e}`)
  found(errorFinding(e))
  process.exitCode = EXIT.error
}
if (envelope) {
  let result: unknown
  if (OWN_JSON.has(command) && log.length > 0)
    try {
      result = JSON.parse(log.join('\n'))
    } catch {
      // Prose after all (an error before the JSON): it stays in log.
    }
  const exitCode = Number(process.exitCode ?? 0)
  process.stdout.write(
    `${JSON.stringify(
      {
        shaderera: 'result/1',
        command,
        ok: exitCode === EXIT.ok,
        exitCode,
        findings,
        ...(result === undefined ? { log } : { result }),
      },
      null,
      2,
    )}\n`,
  )
}
