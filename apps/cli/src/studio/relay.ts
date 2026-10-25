// The CLI's side of the relay (docs/studio.md): pairs with the page by ECDH, and once the page has
// proved it holds the nonce the CLI opened it with, sends it the bridge's port and secret sealed
// under the session key; when the page cannot reach 127.0.0.1, it answers its requests and pushes
// the bridge's events through the relay, sealed the same way. Once paired, it rejoins the relay
// with the resume token the relay gave it when the relay drops it (a site deploy, the network).
import { timingSafeEqual } from 'node:crypto'
import { open } from 'node:fs/promises'
import type { Bridge, StudioEvent } from './bridge.ts'
import {
  CLOSE,
  keyPair,
  mismatch,
  PROTOCOL,
  relayUrl,
  seal,
  sealBytes,
  sessionKey,
  unseal,
} from './pairing.ts'

type Message = { type?: string; [key: string]: unknown }

const sameNonce = (given: string, nonce: string) => {
  const [a, b] = [Buffer.from(given), Buffer.from(nonce)]
  return a.length === b.length && timingSafeEqual(a, b)
}

/** How the relay ended for the CLI; `error` when the CLI itself gave up (a newer page). */
export type RelayEnd = { code: number; paired: boolean; error?: string }

/**
 * A file's chunk through the relay, in bytes: its frame (base64url, with the GCM tag and the JSON
 * around it) stays under 1 MiB, far under the Worker's WebSocket message limit (32 MiB).
 */
export const CHUNK = 512 * 1024
/** How much the CLI lets its socket buffer before it waits to send more of a file. */
const BUFFERED = 8 * 1024 * 1024

/** What binds a chunk's box to its request and place: `<rpc id>:<seq>`. */
export const chunkAad = (id: string, seq: number): string => `${id}:${seq}`

/**
 * How long a page that left has to come back before it counts as closed, in ms: a reload rejoins
 * within it (a new hello, or a request to the bridge directly or through the relay).
 */
export const PAGE_BACK_MS = 10_000

/** How long before a page-left a request of the page's still counts as the page back. */
export const BACK_FIRST_MS = 2000

/** How long the CLI waits before its nth rejoin, in ms: 1, 2, 4, 8, 16, then 30 s. */
export const rejoinDelay = (n: number): number => Math.min(1000 * 2 ** n, 30_000)

/** The answer to `/runner` through the relay: a frame cannot come through it. */
const RUNNER_REFUSED = { status: 400, body: { error: 'The runner is framed from 127.0.0.1 only.' } }

/** What a close code means, for the person. */
export const closeText = (code: number, site: string, id: string): string =>
  code === CLOSE.expired
    ? `Studio session ${id} expired: the page and the CLI did not pair within 10 minutes. Open ${site}/studio for a new one.`
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
  bridge: Pick<Bridge, 'port' | 'secret' | 'handle' | 'onEvent' | 'onVisit'>
  hello: { version: string; os: string; telemetry: boolean }
  onPaired?: () => void
  /**
   * The page left and did not come back within `pageBackMs` (`closed`), or, once paired, came
   * back within it (`reloaded`): a reload is not a close.
   */
  onPage?: (state: 'closed' | 'reloaded') => void
  /**
   * The page's hello names another protocol (mismatch's line). An older page may still reload
   * into the current one, so the CLI waits; for a newer one this CLI is too old, and it ends.
   */
  onMismatch?: (m: { update: 'page' | 'cli'; text: string }) => void
  /** The relay dropped the CLI (`false`), or let it back in (`true`). */
  onRelay?: (back: boolean) => void
  /** For tests: the delay before the nth rejoin. */
  delay?: (n: number) => number
  /** For tests: how long a page that left has to come back (PAGE_BACK_MS). */
  pageBackMs?: number
  /** For tests: a file's chunk, in bytes (CHUNK). */
  chunk?: number
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
  let error: string | undefined
  // The protocol of the last page that said a mismatched hello: said once, not on every hello.
  let told: number | undefined
  // A page that left: closed when this runs out, reloaded when it is seen again before.
  let away: NodeJS.Timeout | undefined
  const pageBack = () => {
    if (!away) return
    clearTimeout(away)
    away = undefined
    // Before pairing, a page that says hello is a page that pairs, not one that reloaded.
    if (paired) o.onPage?.('reloaded')
  }
  // A reloaded page asks the bridge directly (127.0.0.1) at once, while the relay's page-left
  // crosses the internet: its request often comes first. One just before the page-left counts.
  let lastVisit = 0
  const stopVisits = o.bridge.onVisit(() => {
    lastVisit = Date.now()
    pageBack()
  })
  const send = (m: Message) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m))
  }
  // Messages are handled in the order they came: a key is derived before an rpc under it is read.
  // An rpc is only started in order: its answer holds back no later message.
  let chain: Promise<void> = Promise.resolve()

  /**
   * A file through the relay (since v1): its head in the rpc-result, `{status, type, name, size,
   * chunks}`, then `chunks` frames `{type:"rpc-chunk", id, seq, iv, box}`, each up to CHUNK bytes
   * sealed as they are under `<id>:<seq>`. Read and sent a chunk at a time, waiting while the
   * socket's buffer is full, so a large file never sits in memory whole. A file that cannot be
   * opened is a 500; one that fails after its head leaves the page waiting for chunks that do not
   * come, and it gives up.
   */
  const sendFile = async (
    k: CryptoKey,
    id: string,
    file: { path: string; type: string; name: string },
  ) => {
    const size = o.chunk ?? CHUNK
    const handle = await open(file.path).catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      send({
        type: 'rpc-result',
        id,
        ...(await seal(k, { status: 500, body: { error: message } })),
      })
      return null
    })
    if (!handle) return
    try {
      const { size: bytes } = await handle.stat()
      const chunks = Math.ceil(bytes / size)
      send({
        type: 'rpc-result',
        id,
        ...(await seal(k, { status: 200, type: file.type, name: file.name, size: bytes, chunks })),
      })
      const buffer = Buffer.alloc(size)
      for (let seq = 0; seq < chunks; seq++) {
        const { bytesRead } = await handle.read(buffer, 0, size, seq * size)
        const sealed = await sealBytes(k, buffer.subarray(0, bytesRead), chunkAad(id, seq))
        while (ws.readyState === WebSocket.OPEN && ws.bufferedAmount > BUFFERED)
          await new Promise((r) => setTimeout(r, 10))
        send({ type: 'rpc-chunk', id, seq, ...sealed })
      }
    } finally {
      await handle.close()
    }
  }

  /** One rpc of the page's, opened with the session key and answered through the bridge. */
  const answer = async (k: CryptoKey, id: string, sealed: { iv: string; box: string }) => {
    let request: { method?: unknown; path?: unknown; body?: unknown }
    try {
      request = await unseal(k, sealed)
    } catch {
      return send({
        type: 'rpc-result',
        id,
        ...(await seal(k, { status: 400, body: { error: 'box' } })),
      })
    }
    const path = typeof request.path === 'string' ? request.path : '/'
    // Refused before the bridge sees it: a runner (one on a revision opens Vite and a frozen copy)
    // is never started for a frame that cannot come.
    if (new URL(path, 'http://bridge').pathname === '/runner')
      return send({ type: 'rpc-result', id, ...(await seal(k, RUNNER_REFUSED)) })
    const reply = await o.bridge.handle({
      method: typeof request.method === 'string' ? request.method : 'GET',
      path,
      body: request.body,
    })
    if ('json' in reply)
      return send({
        type: 'rpc-result',
        id,
        ...(await seal(k, { status: reply.status, body: reply.json })),
      })
    if ('location' in reply)
      return send({ type: 'rpc-result', id, ...(await seal(k, RUNNER_REFUSED)) })
    // A file, in chunks: not awaited, so the page's other requests are answered meanwhile.
    void sendFile(k, id, reply.file).catch(() => {})
  }

  const onMessage = async (m: Message) => {
    if (m.type === 'page-hello' && typeof m.pub === 'string') {
      pageBack()
      // One key pair for the CLI's life: a page-hello sent again gives the same key, and a new
      // page's (it reloaded before pairing) a new one.
      mine ??= await keyPair()
      // The CLI says its protocol either way, so a page that differs can say so too.
      const theirs = typeof m.protocol === 'number' ? m.protocol : 0
      if (theirs !== PROTOCOL) {
        offered = undefined
        send({ type: 'cli-hello', pub: mine.pub, protocol: PROTOCOL, ...o.hello })
        const said = mismatch(theirs)
        if (told !== theirs) o.onMismatch?.(said)
        told = theirs
        if (said.update === 'cli') {
          // This CLI cannot pair with that page, now or after a reload: it ends.
          error = said.text
          stopped = true
          ws.close(1000)
        }
        return
      }
      offered = await sessionKey(mine.privateKey, m.pub, o.id)
      send({ type: 'cli-hello', pub: mine.pub, protocol: PROTOCOL, ...o.hello })
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
      clearTimeout(away)
      if (paired && Date.now() - lastVisit < BACK_FIRST_MS) {
        away = undefined
        return o.onPage?.('reloaded')
      }
      away = setTimeout(() => {
        away = undefined
        o.onPage?.('closed')
      }, o.pageBackMs ?? PAGE_BACK_MS)
    } else if (m.type === 'rpc' && key && typeof m.iv === 'string' && typeof m.box === 'string') {
      const k = key
      // The page uses the relay: the bridge's events follow, sealed, from now on.
      stopEvents ??= o.bridge.onEvent((event: StudioEvent) => {
        void seal(k, event).then((sealed) => send({ type: 'event', ...sealed }))
      })
      // Not awaited: each request is answered on its own, as direct ones are, and a long one (a
      // share) holds back no other message.
      void answer(k, String(m.id), { iv: m.iv, box: m.box }).catch(() => {})
    }
  }

  let finish: (end: RelayEnd) => void = () => {}
  const closed = new Promise<RelayEnd>((done) => {
    finish = (end) => {
      stopEvents?.()
      stopVisits()
      clearTimeout(away)
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
      if (stopped || answer || !paired || !token)
        return finish({ code: e.code, paired, ...(error ? { error } : {}) })
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
