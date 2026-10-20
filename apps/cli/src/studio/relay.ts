// The CLI's side of the relay (docs/studio.md): pairs with the page by ECDH, and once the page has
// proved it holds the nonce the CLI opened it with, sends it the bridge's port and secret sealed
// under the session key; when the page cannot reach 127.0.0.1, it answers its requests and pushes
// the bridge's events through the relay, sealed the same way. Once paired, it rejoins the relay
// with the resume token the relay gave it when the relay drops it (a site deploy, the network).
import { timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Bridge, StudioEvent } from './bridge.ts'
import { CLOSE, keyPair, relayUrl, seal, sessionKey, unseal } from './pairing.ts'

type Message = { type?: string; [key: string]: unknown }

const sameNonce = (given: string, nonce: string) => {
  const [a, b] = [Buffer.from(given), Buffer.from(nonce)]
  return a.length === b.length && timingSafeEqual(a, b)
}

export type RelayEnd = { code: number; paired: boolean }

/** How long the CLI waits before its nth rejoin, in ms: 1, 2, 4, 8, 16, then 30 s. */
export const rejoinDelay = (n: number): number => Math.min(1000 * 2 ** n, 30_000)

/** What a close code means, for the person. */
export const closeText = (code: number, site: string, id: string): string =>
  code === CLOSE.expired
    ? `Studio session ${id} expired: no CLI paired with it within 10 minutes. Open ${site}/studio for a new one.`
    : code === CLOSE.used
      ? `Studio session ${id} is already paired with another CLI. Open ${site}/studio for a new one.`
      : code === CLOSE.taken
        ? `Studio session ${id} is already open in another page.`
        : code === CLOSE.ended
          ? `Studio session ${id} has ended. Run shaderera studio again for a new one.`
          : `The relay on ${site} closed (${code}).`

/**
 * Connects to the relay as the CLI for studio session `id` and serves `bridge` through it, to the
 * page that proves it holds `nonce` only. Once paired, a close that is not one of the relay's own
 * codes (or 1000) is a drop: it rejoins with its resume token, with backoff (`rejoinDelay`), for
 * as long as it runs. `closed` resolves when the relay closes for good, with its code and whether
 * the page had paired. `close` closes with 1000, which ends the session at the relay.
 */
export const connectRelay = (o: {
  site: string
  id: string
  /** The nonce in the address the CLI opened (pairing.ts's makeNonce). */
  nonce: string
  bridge: Pick<Bridge, 'port' | 'secret' | 'handle' | 'onEvent'>
  hello: { version: string; os: string; telemetry: boolean }
  onPaired?: () => void
  onPageLeft?: () => void
  /** The relay dropped the CLI (`false`), or let it back in (`true`). */
  onRelay?: (back: boolean) => void
  /** For tests: the delay before the nth rejoin. */
  delay?: (n: number) => number
}): { closed: Promise<RelayEnd>; close: () => Promise<void> } => {
  let ws: WebSocket
  // The relay's resume token for this CLI, once paired; rejoins so far since the last open.
  let token: string | undefined
  let tries = 0
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  let mine: Awaited<ReturnType<typeof keyPair>> | undefined
  // The key of the last page-hello, and the key of the page that proved the nonce: only the second
  // gets the bridge and has its requests answered.
  let offered: CryptoKey | undefined
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
      offered = await sessionKey(mine.privateKey, m.pub, o.id)
      send({ type: 'cli-hello', pub: mine.pub, ...o.hello })
    } else if (
      m.type === 'page-proof' &&
      offered &&
      typeof m.iv === 'string' &&
      typeof m.box === 'string'
    ) {
      // The proof opens with the key of the page's hello and holds the nonce: it is the page this
      // CLI opened. Any other page never gets the bridge.
      const k = offered
      const proof = await unseal<{ nonce?: unknown }>(k, { iv: m.iv, box: m.box }).catch(() => null)
      if (typeof proof?.nonce !== 'string' || !sameNonce(proof.nonce, o.nonce)) return
      key = k
      send({ type: 'bridge', ...(await seal(k, { port: o.bridge.port, secret: o.bridge.secret })) })
    } else if (m.type === 'paired') {
      paired = true
      o.onPaired?.()
    } else if (m.type === 'resume' && typeof m.token === 'string') {
      token = m.token
    } else if (m.type === 'resumed') {
      o.onRelay?.(true)
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

  let finish: (end: RelayEnd) => void = () => {}
  const closed = new Promise<RelayEnd>((done) => {
    finish = (end) => {
      stopEvents?.()
      done(end)
    }
  })
  const join = () => {
    const socket = new WebSocket(
      token ? `${relayUrl(o.site, o.id, 'cli')}&resume=${token}` : relayUrl(o.site, o.id, 'cli'),
    )
    ws = socket
    socket.addEventListener('open', () => {
      tries = 0
    })
    socket.addEventListener('message', (e) => {
      let m: Message
      try {
        m = JSON.parse(String(e.data)) as Message
      } catch {
        return
      }
      chain = chain.then(() => onMessage(m)).catch(() => {})
    })
    socket.addEventListener('close', (e) => {
      // The relay's own codes (4001–4004) and 1000 are its answer; anything else, once paired, is
      // a drop, and the CLI comes back with its token. The keys stay: the page goes on.
      const answer = e.code === 1000 || (e.code >= 4000 && e.code < 5000)
      if (stopped || answer || !paired || !token) return finish({ code: e.code, paired })
      if (tries === 0) o.onRelay?.(false)
      timer = setTimeout(join, (o.delay ?? rejoinDelay)(tries++))
    })
  }
  join()
  return {
    closed,
    close: () => {
      stopped = true
      clearTimeout(timer)
      if (ws.readyState === WebSocket.CLOSED) {
        finish({ code: 1000, paired })
        return Promise.resolve()
      }
      // 1000 tells the relay the session ended; wait a moment for it to be sent.
      ws.close(1000)
      return Promise.race([closed.then(() => {}), new Promise<void>((r) => setTimeout(r, 1000))])
    },
  }
}
