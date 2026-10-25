import { randomBytes } from 'node:crypto'
import { Socket } from 'node:net'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { shadereraVersion } from '../deliver/environment.ts'
import { findProject } from '../node/project.ts'
import { seconds } from '../project/comments.ts'
import { isOrigin } from '../player/parents.ts'
import { type StudioEvent, startBridge } from '../studio/bridge.ts'
import { CLOSE, ID_LENGTH, isId, makeId, makeNonce, pageUrl } from '../studio/pairing.ts'
import { closeText, connectRelay, type RelayEnd } from '../studio/relay.ts'
import { claim, register, StudioRunning, stopRunning, unregister } from '../studio/running.ts'
import { noticeOnce, telemetryStatus } from '../studio/telemetry.ts'
import { common } from './args.ts'
import { EXIT } from './findings.ts'
import { apiOf, openBrowser, siteOf } from './site.ts'

/**
 * `shaderera studio [--connect <id>] [--site <origin>] [--api <origin>] [--origin <dev origin>]...
 * [--no-open] [--json]`: the local bridge of the studio page on the site (docs/studio.md, decision
 * 0021). Without `--connect` it makes a studio session id; with it, it takes the id the page made.
 * Either way it opens `<site>/studio/<id>#<nonce>` itself and pairs only with the page that holds
 * that nonce. Share sends films to the films API (`--api`), as `shaderera share` does. It runs
 * until Ctrl-C, SIGTERM, or (stdin a pipe) stdin closing or sending `{"stop":true}`. With `--json`, stdout is one JSON line per event, for an agent that runs it in the
 * background (docs/studio.md, "For agents").
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const { values: v } = parseArgs({
    args: [...argv],
    options: {
      connect: { type: 'string' },
      site: { type: 'string' },
      api: { type: 'string' },
      origin: { type: 'string', multiple: true },
      'no-open': { type: 'boolean' },
      json: { type: 'boolean' },
      stop: { type: 'boolean' },
      ...common,
    },
  })
  const site = siteOf(v.site)
  const api = apiOf(v.api)
  for (const origin of v.origin ?? [])
    if (!isOrigin(origin))
      throw new Error(`--origin takes an origin (scheme, host and port), not ${origin}.`)
  if (v.connect !== undefined && !isId(v.connect))
    throw new Error(
      `Not a studio session id: ${v.connect} (${ID_LENGTH} letters and digits, from ${site}/studio).`,
    )
  const { root } = await findProject(v.root ?? process.cwd())
  if (v.stop) {
    const r = await stopRunning(root)
    if (r.state === 'slow') {
      console.error(
        `Asked the studio for ${root} (pid ${r.pid}) to stop; it is still starting or ending.`,
      )
      return EXIT.failed
    }
    console.log(
      r.state === 'none'
        ? `No studio is running for ${root}.`
        : `Stopped the studio for ${root} (pid ${r.pid}).`,
    )
    return EXIT.ok
  }
  /** One event: a JSON line `{event, ...fields}` with --json, else `text` if any (`error`: stderr). */
  const say = (event: string, fields: object, text?: string, error = false) => {
    if (v.json) console.log(JSON.stringify({ event, ...fields }))
    else if (text !== undefined) (error ? console.error : console.log)(text)
  }
  noticeOnce((text) => say('notice', { text }, `${text}\n`))
  const unreachable = (error: unknown) => {
    const text = `studio --stop cannot reach this studio: ${(error as Error).message}`
    say('log', { level: 'warn', text }, text, true)
  }

  // One studio a project, the one other commands reach (running.ts): claimed before the bridge
  // starts, so two started at once never both run.
  let claimed = false
  try {
    claim(root, process.pid)
    claimed = true
  } catch (error) {
    if (error instanceof StudioRunning) throw error
    unreachable(error)
  }

  let stopNow = () => {}
  // What `studio --stop` carries, in bridge.json: it stops the studio, and opens nothing else.
  const stopToken = randomBytes(16).toString('hex')
  const bridge = await startBridge({
    onStop: () => stopNow(),
    stopToken,
    root,
    api,
    site,
    origins: [site, ...(v.origin ?? []).filter((o) => o !== site)],
    hostFlags: { host: v.host, trusted: v.trusted, timeout: v.timeout },
  }).catch((error: unknown) => {
    unregister(root, process.pid)
    throw error
  })
  // An agent pays for every line: a running job's progress comes once it moved 10 % and 2 s have
  // passed since the last line, and every state change comes.
  const jobLines = new Map<string, { state: string; progress: number; at: number }>()
  const tooSoon = (e: Extract<StudioEvent, { type: 'job' }>) => {
    const last = jobLines.get(e.id)
    const now = Date.now()
    if (last?.state === e.state && (e.progress - last.progress < 0.1 || now - last.at < 2000))
      return true
    if (e.state === 'done' || e.state === 'failed') jobLines.delete(e.id)
    else jobLines.set(e.id, { state: e.state, progress: e.progress, at: now })
    return false
  }
  bridge.onEvent((e) => {
    const { type, ...fields } = e
    if (e.type === 'log') say(type, fields, e.text, e.level !== 'info')
    else if (e.type === 'changed') say(type, fields, `changed: revision ${e.revision}`)
    else if (e.type === 'job' && tooSoon(e)) return
    // The activity is the agent's own record (decision 0025, point 7): not sent back to it.
    else if (e.type === 'activity') return
    else if (e.type === 'comment')
      say(
        type,
        fields,
        `comment ${e.comment.id} (${e.comment.state}) at ${seconds(e.comment.t)} (frame ${e.comment.frame}): ${e.comment.text}`,
      )
    else say(type, fields)
  })
  // It stops on `shaderera studio --stop` (POST /stop), Ctrl-C or SIGTERM, and, when stdin is a
  // pipe (an agent's), when stdin closes or sends the line {"stop":true}: an agent can stop it on
  // any OS without killing it.
  const piped = !process.stdin.isTTY && process.stdin instanceof Socket
  const stop = new Promise<void>((done) => {
    stopNow = done
    process.once('SIGINT', () => done())
    process.once('SIGTERM', () => done())
    if (!piped) return
    const lines = createInterface({ input: process.stdin })
    lines.on('line', (line) => {
      try {
        if ((JSON.parse(line) as { stop?: unknown } | null)?.stop === true) done()
      } catch {}
    })
    lines.on('close', () => done())
  })

  // `shaderera studio --stop` (and later commands) reach this bridge through the file.
  if (claimed)
    try {
      register(root, { port: bridge.port, token: stopToken, pid: process.pid })
    } catch (error) {
      unregister(root, process.pid)
      unreachable(error)
    }

  let id = v.connect ?? makeId()
  let expired: string | undefined
  let relay: ReturnType<typeof connectRelay>
  let end: RelayEnd | null
  // How long the relay keeps an id no CLI paired with (docs/studio.md, "Expiry"). For tests:
  // SHADERERA_STUDIO_EXPIRY_MS.
  const expiryMs = Number(process.env.SHADERERA_STUDIO_EXPIRY_MS) || 10 * 60_000
  let early: string | undefined
  for (;;) {
    const since = Date.now()
    // The page pairs only if it holds the nonce, which only the page opened here has.
    const nonce = makeNonce()
    const page = pageUrl(site, id, nonce, v.connect !== undefined)
    // A new id after one expired is printed, not opened again.
    const opened = !v['no-open'] && !expired
    const why = expired
      ? `No studio page came for session ${expired} within 10 minutes: a new one.`
      : undefined
    say(
      'url',
      {
        url: page,
        id,
        opened,
        project: root,
        bridge: bridge.origin,
        site,
        api,
        ...(expired ? { expired, text: why } : {}),
      },
      [
        ...(why ? [why] : [`project  ${root}`, `bridge   ${bridge.origin} (for ${site} only)`]),
        ...(why ? [] : [`share to ${api}`]),
        `${opened ? 'opening ' : 'open    '} ${page}`,
      ].join('\n'),
    )
    if (opened) openBrowser(page)

    relay = connectRelay({
      site,
      id,
      nonce,
      bridge,
      hello: { version: shadereraVersion(), os: process.platform, telemetry: telemetryStatus().on },
      onPaired: () =>
        say('paired', {}, 'paired: the studio page drives this project. Ctrl-C stops.'),
      onMismatch: (m) => say('mismatch', m, m.text, true),
      // A reload rejoins within a few seconds: only a page that does not is closed.
      onPage: (state) =>
        state === 'closed'
          ? say('page-closed', {}, 'the studio page closed')
          : say('resumed', {}, 'the studio page is back'),
      onRelay: (back) =>
        say(
          'relay',
          { state: back ? 'back' : 'dropped' },
          back
            ? 'the relay is back: the studio page can reach this CLI through it again'
            : 'the relay dropped this CLI; rejoining (the bridge still serves the page directly)',
        ),
    })
    end = await Promise.race([relay.closed, stop.then(() => null)])
    // An id this CLI made that no page came for in time: the CLI waits on a new one. An id the
    // page made (--connect) belongs to that page, and ends.
    if (end && !end.paired && end.code === CLOSE.expired && !end.error && v.connect === undefined) {
      // Only an id that lived out the relay's limit: a relay that expires ids at once would
      // have the CLI make one after another.
      const lived = Date.now() - since
      if (lived >= expiryMs * 0.9) {
        expired = id
        id = makeId()
        continue
      }
      early = `The relay on ${site} expired studio session ${id} after ${(lived / 1000).toFixed(1)} s, not ${expiryMs / 60_000} minutes. Update the CLI (npm i shaderera@latest), or check --site.`
    }
    break
  }
  let code: number = EXIT.ok
  let error: string | undefined
  if (end && !end.paired) {
    // Never paired: there is no page to serve.
    error = end.error ?? early ?? closeText(end.code, site, id)
    code = EXIT.error
  } else if (end) {
    // Paired already: the page talks to the bridge directly, which keeps serving.
    say(
      'relay',
      { state: 'closed', code: end.code },
      'the relay closed; the bridge still serves the page directly. Ctrl-C stops.',
    )
    await stop
  }
  await relay.close()
  await bridge.close()
  unregister(root, process.pid)
  say('ended', { exitCode: code, ...(error ? { error } : {}) }, error, true)
  if (piped) process.stdin.destroy()
  return code
}
