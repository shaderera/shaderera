import { existsSync } from 'node:fs'
import { recordable, recordCommand } from '../project/activity.ts'
import { COMMANDS as PLUGIN, usage as pluginUsage } from '../registry/cli.ts'
import { closest } from './closest.ts'
import { EXIT, errorFinding, findings, found } from './findings.ts'

const usage = `Usage: shaderera <command> [--root <dir>] [--variant <name>] [--host node|browser] [--trusted] [--timeout <s>] [options]

Commands:
  inspect <t> [--path a.b] [--json]          print the source's state at t
  inspect --track a.b [--from s] [--to s] [--json]   a value at every frame, and its speed
  check [--samples 50] [--seed 1] [--hdr10] [--no-types]   typecheck, then render each t twice in two orders and compare
  still <t>... [--every s] [--sheet] [--diff] [--compare variant] [--region x,y,w,h | --object id] [--scale n] [--out dir] [--json]   stills of any moment, and a contact sheet
  render [--job name] [--from s] [--to s] [--out file] [--format mp4|prores-hq|prores-4444] [--master] [--crf 18] [--encoder name] [--bitrate r | --maxrate r] [--no-edit-list] [--stems] [--progress] [--no-audio] [--loudness=LUFS] [--workers n] [--software-gpu] [--hdr10] [--draft [height]] [--retries n] [--chunk i [--plan dir]] [--reuse plan --changed a-b [--fix]] [--force]   export an mp4 or a ProRes mov (--draft: 360 px high by default, full fps, out/<name>-draft.mp4) (a png job: frames + audio.wav + delivery.json)
  deliver [--variants main,a,b] [--locales en,th] [--format f] [--png] [--master] [--bitrate r | --maxrate r] [--no-edit-list] [--stems] [--bits 16] [--no-audio] [--loudness=LUFS] [--hdr10 [--sdr]] [--name batch] [--job j]... [--replace] [--software-gpu]   campaign batch into out/deliveries/<batch>/
  plan --job j [--chunks 4] [--out dir]        split a job into chunks any machine renders (render --job j --chunk i)
  plan --status --plan dir [--verify]        which chunks of a plan are done, missing, stale, partial or claimed
  assemble --plan dir [--out file] [--job j] [--crf n] [--retries n]   encode a plan's chunks once, with the sound (--job: another delivery of the same job)
  reexport audio|captions --job j [--onto file] [--out file] [--no-audio] [--loudness=LUFS]   a job's sound on a delivered file's own picture, or its caption sidecars, with no frame rendered
  handoff <job> [--verify] [--clean-install]   frozen project + job + REPRODUCE.md in out/handoff/<job>/
  review [--out dir] [--requirements file] [--quick] [--json]   frames, a contact sheet and technical checks
  bake [name...]                             run a bake's command and stamp the frames it made
  doctor [--json]                            what this machine and project have and lack (ffmpeg, encoders, Chrome, Dawn, GPU, disk space)
  mcp                                        serve the CLI as MCP tools over stdio
  activity [--last 20] [--json]              what the CLI, the agent and the studio did in this project
  activity add [--comment id] <text>         add a note of what you mean to do to the activity

Versions and jobs:
  save [--label text]                        save the project as a revision
  versions [--json]                          saved revisions, restores, undos and jobs
  undo                                       back to the previous revision
  restore <revision>                         make the project that revision
  diff <a> [<b>] [--stat]                    what changed between revisions (or now)
  comments [list|show|add|reply|reopen] [--state s] [--at t] [--point x,y | --box x,y,w,h] [--fixed] [--wait] [--json]   the comments on the film: read, add, reply (--fixed saves the fix), reopen; resolve is the person's, in the studio; --wait for the next one
  prune [--dry-run] [--keep 10]              remove the revisions nobody names, and the objects only they held
  job [--variant v] [--params json] [--revision id] [--name n] [--format f] [--png] [--master] [--bits 16] [--stems] [--hdr10]   freeze a render job

shaderera.com: the films API is --api <origin>, else SHADERERA_API, else https://api.shaderera.com;
the site (film pages, the studio page, plugins) is --site <origin>, else SHADERERA_SITE, else https://shaderera.com:
  login [--api origin] [--no-open]           sign in with GitHub and keep the token share sends to that API
  login --token <token> [--api origin]       keep a token given by hand instead
  whoami [--api origin] [--json]             who this machine is signed in as
  logout [--api origin] [--all]              sign this machine out (--all: every machine)
  share [--film id] [--title t] [--no-media] [--dry-run] [--host h] [--trusted] [--timeout s] [--yes] [--api origin] [--site origin] [--json]   send the project's files as a new film or version (--dry-run: send nothing)
  fork <film|url>[@version] [dir] [--api origin] [--site origin] [--json]   copy a published version into a new folder
  studio [--connect id] [--site origin] [--api origin] [--origin dev-origin]... [--no-open] [--json]   the local bridge of the studio page (--json: one JSON line per event)
  studio --stop                              stop the studio running for this project, cleanly
  telemetry off|on|status                    whether the studio page counts how the studio is used

${pluginUsage}

check, inspect, still, render and review take --param k=v (repeatable): a param over the defaults.
check, still and review take several variants (--variant a,b or --variants all): one host each, at once.

Stills: still (out/stills/). A review with technical checks: review (out/review/).`

/** What `shaderera` alone prints: the commands a person starts with, and where the rest are. */
const FIRST = `Usage: shaderera <command> [options], in a project's folder

  check        check that every frame is a function of t
  still <t>    a still of any moment, in out/stills/
  render       export the film, to out/
  studio       open the film in the studio on shaderera.com

shaderera help lists every command and flag; shaderera <command> --help, one command's.`

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
  'activity',
  'save',
  'versions',
  'undo',
  'restore',
  'diff',
  'prune',
  'comments',
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
  'check',
  'plan',
  'still',
  'render',
  'review',
  'save',
  'job',
  'diff',
  'undo',
  'restore',
  'versions',
  'comments',
  'doctor',
  'activity',
  'search',
  'info',
  'share',
  'fork',
  'whoami',
])
/**
 * Commands that own stdout (a protocol, or a bridge that runs until Ctrl-C): never wrapped. studio's
 * own `--json` prints one JSON line per event.
 */
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

/** One command's lines of the usage, or the whole usage for none (or one it has no line for). */
export const usageOf = (command?: string): string => {
  const lines = usage.split('\n').filter((l) => command && l.startsWith(`  ${command} `))
  return lines.length > 0 ? lines.join('\n') : usage
}

/** A name that is no command: says so on stderr, with the nearest one. */
const unknown = (name: string): number => {
  const near = closest(name, commands)
  console.error(
    `shaderera: Unknown command: ${name}.${near ? ` Did you mean ${near}?` : ''} \`shaderera help\` lists the commands.`,
  )
  found({ code: 'usage', severity: 'error', message: `Unknown command: ${name}` })
  return EXIT.error
}

type Command = { run(argv: readonly string[]): Promise<number>; usage?: string }

/** A command's module, or undefined when it has none yet. */
const load = async (command: string): Promise<Command | undefined> => {
  const url = new URL(`./${command}${import.meta.url.slice(-3)}`, import.meta.url)
  return existsSync(url) ? import(url.href) : undefined
}

/** What `<command> --help` prints: the module's own usage when it has one, else its usage lines. */
export const helpOf = async (command: string): Promise<string> =>
  (await load(command))?.usage ?? usageOf(command)

/** The flags any command takes: in the usage's lines that are no command's. */
export const COMMON = usage
  .split('\n')
  .filter((l) => !l.startsWith('  '))
  .join('\n')

/**
 * A flag the command does not take (parseArgs' ERR_PARSE_ARGS_UNKNOWN_OPTION), said in the CLI's
 * words: the nearest flag its help names, and where the rest are. A negative number is a time
 * before the film. Any other error stays as it is (undefined).
 */
const unknownFlag = (command: string, help: string, e: unknown): Error | undefined => {
  const code = (e as { code?: unknown })?.code
  if (code !== 'ERR_PARSE_ARGS_UNKNOWN_OPTION') return undefined
  const flag = /'([^']+)'/.exec((e as Error).message)?.[1] ?? ''
  const more = `(shaderera ${command} --help)`
  const flags = [...new Set([...`${help}\n${COMMON}`.matchAll(/--[a-z][a-z0-9-]*/g)].map(String))]
  const near = closest(flag, flags)
  const message = /^-\d/.test(flag)
    ? `Times start at 0: ${flag} is before the film. ${more}`
    : `Unknown flag ${flag} for ${command}.${near ? ` Did you mean ${near}?` : ''} ${more}`
  return Object.assign(new Error(message), { code })
}

const main = async (argv: readonly string[]): Promise<number> => {
  const [command, ...rest] = argv
  if (!command) {
    console.log(FIRST)
    return EXIT.ok
  }
  // `help [command]`, `<command> --help`: that command's help; no command: all of the usage.
  if (command === 'help' || command === '--help' || command === '-h') {
    const about = rest.find((a) => !a.startsWith('-'))
    if (about && !commands.includes(about)) return unknown(about)
    console.log(about ? await helpOf(about) : usage)
    return EXIT.ok
  }
  if (!commands.includes(command)) return unknown(command)
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(await helpOf(command))
    return EXIT.ok
  }
  const gone = goneFlag(command, rest)
  if (gone) throw new Error(gone)
  const module = await load(command)
  if (!module) {
    console.error(`shaderera ${command} is not available yet`)
    return EXIT.error
  }
  try {
    return await module.run(rest)
  } catch (e) {
    throw unknownFlag(command, module.usage ?? usageOf(command), e) ?? e
  }
}

/**
 * Runs the CLI on `argv` (what follows `shaderera`) and gives its exit code. `--json` on any
 * command but mcp and studio (its own `--json` streams events): stdout is one envelope (`result/1`), what the command printed goes
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
  // Activity, once per command run in a project; a write that fails changes nothing.
  const asked = given.includes('--help') || given.includes('-h')
  if (commands.includes(command) && recordable(given, exitCode) && !asked)
    recordCommand({ argv: given, exitCode, findings })
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
