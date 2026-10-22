import { parseArgs } from 'node:util'
import { shadereraVersion } from '../deliver/environment.ts'
import { findProject } from '../node/project.ts'
import { isOrigin } from '../player/parents.ts'
import { startBridge } from '../studio/bridge.ts'
import { ID_LENGTH, isId, makeId, makeNonce, pageUrl } from '../studio/pairing.ts'
import { closeText, connectRelay } from '../studio/relay.ts'
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
 * until Ctrl-C. With `--json`, stdout is one JSON line per event, for an agent that runs it in the
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
  /** One event: a JSON line `{event, ...fields}` with --json, else `text` if any (`error`: stderr). */
  const say = (event: string, fields: object, text?: string, error = false) => {
    if (v.json) console.log(JSON.stringify({ event, ...fields }))
    else if (text !== undefined) (error ? console.error : console.log)(text)
  }
  noticeOnce((text) => say('notice', { text }, `${text}\n`))

  const bridge = await startBridge({
    root,
    api,
    site,
    origins: [site, ...(v.origin ?? []).filter((o) => o !== site)],
    hostFlags: { host: v.host, trusted: v.trusted, timeout: v.timeout },
  })
  bridge.onEvent((e) => {
    const { type, ...fields } = e
    if (e.type === 'log') say(type, fields, e.text, e.level !== 'info')
    else if (e.type === 'changed') say(type, fields, `changed: revision ${e.revision}`)
    else say(type, fields)
  })
  const id = v.connect ?? makeId()
  // The page pairs only if it holds the nonce, which only the page opened here has.
  const nonce = makeNonce()
  const page = pageUrl(site, id, nonce, v.connect !== undefined)
  const opened = !v['no-open']
  say(
    'url',
    { url: page, id, opened, project: root, bridge: bridge.origin, site, api },
    [
      `project  ${root}`,
      `bridge   ${bridge.origin} (for ${site} only)`,
      `share to ${api}`,
      `${opened ? 'opening ' : 'open    '} ${page}`,
    ].join('\n'),
  )
  if (opened) openBrowser(page)

  const relay = connectRelay({
    site,
    id,
    nonce,
    bridge,
    hello: { version: shadereraVersion(), os: process.platform, telemetry: telemetryStatus().on },
    onPaired: () => say('paired', {}, 'paired: the studio page drives this project. Ctrl-C stops.'),
    // A reload rejoins within a few seconds: only a page that does not is closed.
    onPage: (state) =>
      state === 'closed'
        ? say('page-closed', {}, 'the studio page closed')
        : say('resumed', {}, 'the studio page reloaded'),
    onRelay: (back) =>
      say(
        'relay',
        { state: back ? 'back' : 'dropped' },
        back
          ? 'the relay is back: the studio page can reach this CLI through it again'
          : 'the relay dropped this CLI; rejoining (the bridge still serves the page directly)',
      ),
  })
  const stop = new Promise<void>((done) => process.once('SIGINT', () => done()))
  const end = await Promise.race([relay.closed, stop.then(() => null)])
  let code: number = EXIT.ok
  let error: string | undefined
  if (end && !end.paired) {
    // Never paired: there is no page to serve.
    error = closeText(end.code, site, id)
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
  say('ended', { exitCode: code, ...(error ? { error } : {}) }, error, true)
  return code
}
