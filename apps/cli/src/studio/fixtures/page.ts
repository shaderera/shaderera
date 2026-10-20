// The two sides a studio test talks to the CLI with: the bridge over HTTP, and the studio
// page over the relay, as the page does it, with WebCrypto.
import { request as httpRequest } from 'node:http'
import { keyPair, relayUrl, sessionKey, unseal } from '../pairing.ts'

/** One request to the bridge, with the headers given (Node's fetch would not set Origin). */
export const call = (
  port: number,
  o: { method?: string; path: string; headers?: Record<string, string>; body?: unknown },
) =>
  new Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>((done, fail) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: o.method ?? 'GET',
        path: o.path,
        headers: {
          ...o.headers,
          ...(o.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
      },
      (res) => {
        const parts: Buffer[] = []
        res.on('data', (p: Buffer) => parts.push(p))
        res.on('end', () =>
          done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) }),
        )
      },
    )
    req.on('error', fail)
    req.end(o.body === undefined ? undefined : JSON.stringify(o.body))
  })

/** The page's side of the relay, as the studio page does it, with WebCrypto. */
export const page = (relay: string, id: string) => {
  const ws = new WebSocket(relayUrl(relay, id, 'page'))
  const inbox: { type: string; [k: string]: unknown }[] = []
  const waiting: { type: string; done: (m: (typeof inbox)[number]) => void }[] = []
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data))
    const w = waiting.find((x) => x.type === m.type)
    if (w) {
      waiting.splice(waiting.indexOf(w), 1)
      w.done(m)
    } else inbox.push(m)
  })
  const next = (type: string) =>
    new Promise<(typeof inbox)[number]>((done) => {
      const at = inbox.findIndex((m) => m.type === type)
      if (at >= 0) done(inbox.splice(at, 1)[0] as (typeof inbox)[number])
      else waiting.push({ type, done })
    })
  const closed = new Promise<number>((done) => ws.addEventListener('close', (e) => done(e.code)))
  const opened = new Promise<void>((done) => ws.addEventListener('open', () => done()))
  return {
    ws,
    next,
    closed,
    opened,
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    /** page-hello now and on every cli-joined; resolves with the session key and the bridge. */
    pair: async () => {
      const mine = await keyPair()
      await opened
      ws.send(JSON.stringify({ type: 'page-hello', pub: mine.pub }))
      void next('cli-joined').then(() =>
        ws.send(JSON.stringify({ type: 'page-hello', pub: mine.pub })),
      )
      const hello = await next('cli-hello')
      const key = await sessionKey(mine.privateKey, hello.pub as string, id)
      const sealed = (await next('bridge')) as unknown as { iv: string; box: string }
      const bridge = await unseal<{ port: number; secret: string }>(key, sealed)
      ws.send(JSON.stringify({ type: 'paired' }))
      return { key, hello, bridge }
    },
  }
}
