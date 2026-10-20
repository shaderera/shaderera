// The CLI's side of the relay (docs/studio.md): pairs with the page by ECDH, sends it the bridge's
// port and secret sealed under the session key, and, when the page cannot reach 127.0.0.1, answers
// its requests and pushes the bridge's events through the relay, sealed the same way.
import { readFileSync } from 'node:fs'
import type { Bridge, StudioEvent } from './bridge.ts'
import { CLOSE, keyPair, relayUrl, seal, sessionKey, unseal } from './pairing.ts'

type Message = { type?: string; [key: string]: unknown }

export type RelayEnd = { code: number; reason: string; paired: boolean }

/** What a close code means, for the person. */
export const closeText = (code: number, site: string, id: string): string =>
  code === CLOSE.expired
    ? `Studio session ${id} expired: no CLI paired with it within 10 minutes. Open ${site}/studio for a new one.`
    : code === CLOSE.used
      ? `Studio session ${id} is already paired with another CLI. Open ${site}/studio for a new one.`
      : code === CLOSE.taken
        ? `Studio session ${id} is already open in another page.`
        : `The relay on ${site} closed (${code}).`

/**
 * Connects to the relay as the CLI for studio session `id` and serves `bridge` through it.
 * `closed` resolves when the relay closes, with its code and whether the page had paired.
 */
export const connectRelay = (o: {
  site: string
  id: string
  bridge: Pick<Bridge, 'port' | 'secret' | 'handle' | 'onEvent'>
  hello: { version: string; os: string; telemetry: boolean }
  onPaired?: () => void
  onPageLeft?: () => void
}): { closed: Promise<RelayEnd>; close: () => void } => {
  const ws = new WebSocket(relayUrl(o.site, o.id, 'cli'))
  let mine: Awaited<ReturnType<typeof keyPair>> | undefined
  let key: CryptoKey | undefined
  let paired = false
  let stopEvents: (() => void) | undefined
  const send = (m: Message) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m))
  }
  // Messages are handled in the order they came: a key is derived before an rpc under it is read.
  let chain: Promise<void> = Promise.resolve()

  const onMessage = async (m: Message) => {
    if (m.type === 'page-hello' && typeof m.pub === 'string') {
      // One key pair for the CLI's life: a page-hello sent again gives the same key, and a new
      // page's (it reloaded before pairing) a new one.
      mine ??= await keyPair()
      key = await sessionKey(mine.privateKey, m.pub, o.id)
      send({ type: 'cli-hello', pub: mine.pub, ...o.hello })
      send({
        type: 'bridge',
        ...(await seal(key, { port: o.bridge.port, secret: o.bridge.secret })),
      })
    } else if (m.type === 'paired') {
      paired = true
      o.onPaired?.()
    } else if (m.type === 'page-left') {
      o.onPageLeft?.()
    } else if (m.type === 'rpc' && key && typeof m.iv === 'string' && typeof m.box === 'string') {
      const k = key
      const id = m.id
      // The page uses the relay: the bridge's events follow, sealed, from now on.
      stopEvents ??= o.bridge.onEvent((event: StudioEvent) => {
        void seal(k, event).then((sealed) => send({ type: 'event', ...sealed }))
      })
      let request: { method?: unknown; path?: unknown; body?: unknown }
      try {
        request = await unseal(k, { iv: m.iv, box: m.box })
      } catch {
        return send({
          type: 'rpc-result',
          id,
          ...(await seal(k, { status: 400, body: { error: 'box' } })),
        })
      }
      const reply = await o.bridge.handle({
        method: typeof request.method === 'string' ? request.method : 'GET',
        path: typeof request.path === 'string' ? request.path : '/',
        body: request.body,
      })
      if ('json' in reply)
        return send({
          type: 'rpc-result',
          id,
          ...(await seal(k, { status: reply.status, body: reply.json })),
        })
      if ('location' in reply)
        return send({
          type: 'rpc-result',
          id,
          ...(await seal(k, {
            status: 400,
            body: { error: 'The runner is framed from 127.0.0.1 only.' },
          })),
        })
      // A file, in one frame (v0): `{ status, type, name, base64 }`.
      const bytes = readFileSync(reply.file.path)
      send({
        type: 'rpc-result',
        id,
        ...(await seal(k, {
          status: 200,
          type: reply.file.type,
          name: reply.file.name,
          base64: bytes.toString('base64'),
        })),
      })
    }
  }

  ws.addEventListener('message', (e) => {
    let m: Message
    try {
      m = JSON.parse(String(e.data)) as Message
    } catch {
      return
    }
    chain = chain.then(() => onMessage(m)).catch(() => {})
  })
  const closed = new Promise<RelayEnd>((done) =>
    ws.addEventListener('close', (e) => {
      stopEvents?.()
      done({ code: e.code, reason: e.reason, paired })
    }),
  )
  return { closed, close: () => ws.close(1000) }
}
