import { randomBytes } from 'node:crypto'
import { Socket } from 'node:net'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { shadereraVersion } from '../deliver/environment.ts'
import { findProject } from '../node/project.ts'
import { isOrigin } from '../player/parents.ts'
import { seconds } from '../project/comments.ts'
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
 * that nonce. Once that page has closed for good, it prints a new session's address, on the same
 * bridge, and keeps the old one until a page comes back to either. Share sends films to the
 * films API (`--api`), as `shaderera share` does. It runs
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

  // How long the relay keeps an id no CLI paired with (docs/studio.md, "Expiry"). For tests:
  // SHADERERA_STUDIO_EXPIRY_MS, and SHADERERA_STUDIO_PAGE_BACK_MS (relay.ts's PAGE_BACK_MS).
  const expiryMs = Number(process.env.SHADERERA_STUDIO_EXPIRY_MS) || 10 * 60_000
  const pageBackMs = Number(process.env.SHADERERA_STUDIO_PAGE_BACK_MS) || undefined
  type Session = { id: string; web: boolean; since: number; relay: ReturnType<typeof connectRelay> }
  // The session that serves the page, and, once its page has closed for good, a standby on the
  // same bridge with a new id: a closed tab cannot rejoin its session (the relay lets a page back
  // only with the token its tab kept), but a tab the browser discarded, or one on a laptop that
  // slept, comes back with it. Whichever page comes first wins, and the other session ends.
  let active: Session
  let standby: Session | undefined
  // Whether a page ever paired, and how the loop below hears the standby won.
  let ever = false
  let swap = () => {}
  /** A studio session on the bridge: its address said (and opened, the first), its relay joined. */
  const open = (id: string, web: boolean, last?: { expired: string } | { closed: string }) => {
    // The page pairs only if it holds the nonce, which only the page opened here has.
    const nonce = makeNonce()
    const page = pageUrl(site, id, nonce, web)
    // A new id is printed, not opened: a tab the person closed is not opened again.
    const opened = !v['no-open'] && !last
    const why = !last
      ? undefined
      : 'expired' in last
        ? `No studio page came for session ${last.expired} within 10 minutes: a new one.`
        : `The studio page of session ${last.closed} closed: a new one, while it may come back.`
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
        ...(last ? { ...last, text: why } : {}),
      },
      [
        ...(why ? [why] : [`project  ${root}`, `bridge   ${bridge.origin} (for ${site} only)`]),
        ...(why ? [] : [`share to ${api}`]),
        `${opened ? 'opening ' : 'open    '} ${page}`,
      ].join('\n'),
    )
    if (opened) openBrowser(page)
    const s = { id, web, since: Date.now() } as Session
    let paired = false
    s.relay = connectRelay({
      site,
      id,
      nonce,
      bridge,
      hello: { version: shadereraVersion(), os: process.platform, telemetry: telemetryStatus().on },
      // The standby's page has the bridge: it won (before its `paired`, as its requests to the
      // bridge would look like the old page back), and the old session ends.
      onBridge: () => {
        if (s !== standby) return
        const old = active
        active = s
        standby = undefined
        void old.relay.close()
        swap()
      },
      onPaired: () => {
        paired = ever = true
        say('paired', {}, 'paired: the studio page drives this project. Ctrl-C stops.')
      },
      onMismatch: (m) => say('mismatch', m, m.text, true),
      // A reload rejoins within a few seconds: only a page that does not is closed.
      onPage: (state) => {
        if (s !== active) return
        if (state === 'closed') {
          say('page-closed', {}, 'the studio page closed')
          if (paired && !standby) standby = open(makeId(), false, { closed: id })
          return
        }
        say('resumed', {}, 'the studio page is back')
        // The old page came back first: the standby's address goes unused.
        const unused = standby
        standby = undefined
        void unused?.relay.close()
      },
      onRelay: (back) =>
        say(
          'relay',
          { state: back ? 'back' : 'dropped' },
          back
            ? 'the relay is back: the studio page can reach this CLI through it again'
            : 'the relay dropped this CLI; rejoining (the bridge still serves the page directly)',
        ),
      ...(pageBackMs ? { pageBackMs } : {}),
    })
    // A standby the relay ended by itself: a new one when its id expired as it should, else said.
    void s.relay.closed.then((end) => {
      if (s !== standby) return
      standby = undefined
      if (end.code === CLOSE.expired && !end.error && Date.now() - s.since >= expiryMs * 0.9)
        standby = open(makeId(), false, { expired: id })
      else {
        const text = end.error ?? closeText(end.code, site, id)
        say('log', { level: 'warn', text }, text, true)
      }
    })
    return s
  }

  active = open(v.connect ?? makeId(), v.connect !== undefined)
  let end: RelayEnd | null
  let early: string | undefined
  for (;;) {
    const swapped = new Promise<'swap'>((done) => {
      swap = () => done('swap')
    })
    const next = await Promise.race([active.relay.closed, stop.then(() => null), swapped])
    if (next === 'swap') continue
    end = next
    // An id this CLI made that no page came for in time: the CLI waits on a new one. An id the
    // page made (--connect) belongs to that page, and ends.
    if (end && !ever && end.code === CLOSE.expired && !end.error && !active.web) {
      // Only an id that lived out the relay's limit: a relay that expires ids at once would
      // have the CLI make one after another.
      const lived = Date.now() - active.since
      if (lived >= expiryMs * 0.9) {
        active = open(makeId(), false, { expired: active.id })
        continue
      }
      early = `The relay on ${site} expired studio session ${active.id} after ${(lived / 1000).toFixed(1)} s, not ${expiryMs / 60_000} minutes. Update the CLI (npm i shaderera@latest), or check --site.`
    }
    break
  }
  let code: number = EXIT.ok
  let error: string | undefined
  if (end && !ever) {
    // Never paired: there is no page to serve.
    error = end.error ?? early ?? closeText(end.code, site, active.id)
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
  const unused = standby
  standby = undefined
  await Promise.all([active.relay.close(), unused?.relay.close()])
  await bridge.close()
  unregister(root, process.pid)
  say('ended', { exitCode: code, ...(error ? { error } : {}) }, error, true)
  if (piped) process.stdin.destroy()
  return code
}
