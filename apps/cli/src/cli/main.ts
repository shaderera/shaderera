import { existsSync } from 'node:fs'
import { COMMANDS as PLUGIN, usage as pluginUsage } from '../registry/cli.ts'
import { EXIT, errorFinding, findings, found } from './findings.ts'

const usage = `Usage: shaderera <command> [--root <dir>] [--variant <name>] [--trusted] [--timeout <s>] [options]

Commands:
  inspect <t> [--path a.b] [--json]          print the source's state at t
  check [--times 50] [--seed 1] [--hdr10]    render each t twice in two orders and compare
  still <t>... [--every s] [--sheet] [--diff] [--compare variant] [--out dir] [--json]   stills of any moment, and a contact sheet
  render [--job name] [--from s] [--to s] [--out file] [--format mp4|prores-hq|prores-4444] [--crf 18] [--bitrate r | --maxrate r] [--no-edit-list] [--stems] [--progress] [--no-audio] [--loudness=LUFS] [--software-gpu] [--hdr10] [--retries n]   export an mp4 or a ProRes mov (a png job: frames + audio.wav + delivery.json)
  deliver [--variants main,a,b] [--locales en,th] [--format f] [--png] [--master] [--bitrate r | --maxrate r] [--no-edit-list] [--stems] [--bits 16] [--no-audio] [--loudness=LUFS] [--name batch] [--job j]... [--replace] [--software-gpu]   campaign batch into out/deliveries/<batch>/
  plan --job j [--chunks 4] [--out dir]        split a job into chunks any machine renders (render --job j --chunk i)
  plan --status --plan dir [--verify]        which chunks of a plan are done, missing, stale, partial or claimed
  assemble --plan dir [--out file] [--job j] [--crf n] [--retries n]   encode a plan's chunks once, with the sound (--job: another delivery of the same job)
  reexport audio|captions --job j [--onto file] [--out file] [--no-audio] [--loudness=LUFS]   a job's sound on a delivered file's own picture, or its caption sidecars, with no frame rendered
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
  job [--variant v] [--params json] [--revision id] [--name n] [--format f] [--png] [--master] [--bits 16] [--stems] [--hdr10]   freeze a render job

shaderera.com: the films API is --api <origin>, else SHADERERA_API, else https://api.shaderera.com;
the site (film pages, the studio page, plugins) is --site <origin>, else SHADERERA_SITE, else https://shaderera.com:
  login [--api origin] [--no-open]           sign in with GitHub and keep the token share sends to that API
  login --token <token> [--api origin]       keep a token given by hand instead
  whoami [--api origin] [--json]             who this machine is signed in as
  logout [--api origin] [--all]              sign this machine out (--all: every machine)
  share [--film id] [--title t] [--no-media] [--dry-run] [--host h] [--trusted] [--timeout s] [--yes] [--api origin] [--site origin] [--json]   send the project's files as a new film or version (--dry-run: send nothing)
  fork <film|url>[@version] [dir] [--api origin] [--site origin] [--json]   copy a published version into a new folder
  studio [--connect id] [--site origin] [--api origin] [--origin dev-origin]... [--no-open]   the local bridge of the studio page
  telemetry off|on|status                    whether the studio page counts how the studio is used

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
  'reexport',
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
  'logout',
  'whoami',
  'share',
  'fork',
  'studio',
  'telemetry',
  ...PLUGIN,
]

/** Commands whose own `--json` prints their result as JSON: the envelope carries it as `result`. */
const OWN_JSON = new Set([
  'inspect',
  'plan',
  'still',
  'review',
  'versions',
  'doctor',
  'search',
  'info',
  'share',
  'fork',
  'whoami',
])
/** Commands that own stdout (a protocol, or a bridge that runs until Ctrl-C): never wrapped. */
const STREAMS = new Set(['mcp', 'studio'])

/** The commands that talk to the films API or the site: they take --api and --site. */
const ONLINE = new Set(['login', 'logout', 'whoami', 'share', 'fork', 'studio', ...PLUGIN])
/** Their flags before --api and --site (#207), named so the error says what to use instead. */
const GONE: Record<string, string> = {
  '--to': 'use --api <origin>',
  '--from': 'use --site <origin|folder>',
  '--parent': "the player's parents come from the films API (--api <origin>)",
}

/** A flag an online command no longer takes: what to use instead, or null. */
export const goneFlag = (command: string, args: readonly string[]): string | null => {
  if (!ONLINE.has(command)) return null
  for (const a of args) {
    const flag = a.split('=')[0] ?? ''
    if (flag in GONE) return `shaderera ${command} has no ${flag}: ${GONE[flag]}.`
  }
  return null
}

const main = async (argv: readonly string[]): Promise<number> => {
  const [command, ...rest] = argv
  const help = !command || ['--help', '-h'].some((h) => command === h || rest.includes(h))
  if (help || !commands.includes(command)) {
    console.log(usage)
    if (!help) found({ code: 'usage', severity: 'error', message: `Unknown command: ${command}` })
    return help ? EXIT.ok : EXIT.error
  }
  const gone = goneFlag(command, rest)
  if (gone) throw new Error(gone)
  const url = new URL(`./${command}${import.meta.url.slice(-3)}`, import.meta.url)
  if (!existsSync(url)) {
    console.error(`shaderera ${command} is not available yet`)
    return EXIT.error
  }
  const module: { run(argv: readonly string[]): Promise<number> } = await import(url.href)
  return module.run(rest)
}

/**
 * Runs the CLI on `argv` (what follows `shaderera`) and gives its exit code. `--json` on any
 * command but mcp and studio: stdout is one envelope (`result/1`), what the command printed goes
 * into it (`result` when the command printed JSON, `log` otherwise), and the exit code is the same
 * as without it. bin/shaderera.js runs it on the process's arguments, as `node main.ts` does; a
 * test runs it in its own process (fixtures/cli.ts).
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const command = argv[0] ?? ''
  const envelope = argv.includes('--json') && !STREAMS.has(command)
  const log: string[] = []
  const print = console.log
  findings.length = 0
  if (envelope) console.log = (...parts: unknown[]) => log.push(parts.map(String).join(' '))
  const given = envelope && !OWN_JSON.has(command) ? argv.filter((a) => a !== '--json') : argv
  let exitCode: number
  try {
    exitCode = await main(given)
  } catch (e) {
    if (!envelope)
      console.error(process.env.SHADERERA_DEBUG ? e : `shaderera: ${(e as Error).message ?? e}`)
    found(errorFinding(e))
    exitCode = EXIT.error
  } finally {
    console.log = print
  }
  if (envelope) {
    let result: unknown
    if (OWN_JSON.has(command) && log.length > 0)
      try {
        result = JSON.parse(log.join('\n'))
      } catch {
        // Prose after all (an error before the JSON): it stays in log.
      }
    console.log(
      JSON.stringify(
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
      ),
    )
  }
  return exitCode
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2))
