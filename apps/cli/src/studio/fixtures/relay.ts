// A stand-in for the site's studio relay (docs/studio.md, "The relay"), in memory, for tests: a
// WebSocket server of its own (RFC 6455, text and close frames only) at
// /studio/relay/<id>?role=page|cli, with the relay's rules:
// - an id not paired within `ttlMs` of its first connection is expired: a CLI gets 4001; with
//   `alarm`, the sockets still on it then get 4001 too, and the id is forgotten, as the Worker's
//   alarm does;
// - once the page sends `paired` (taken only after the CLI there has sent `bridge`), the id is
//   used: a CLI gets 4002 and a page 4003;
// - before that, a second CLI gets 4002 too, and a second page replaces the first (a reload);
// - `cli-joined` goes to the page when a CLI connects; `page-left`/`cli-left` when a side closes;
// - on `paired`, the CLI gets `{type:"resume", token}`; a CLI that comes back with
//   `&resume=<token>` replaces the one there and gets `{type:"resumed"}`, until the session ended:
//   the paired CLI closed with 1000, and the page was closed with 4004;
// - every other frame goes to the other side as it is;
// - a message over `maxMessage` bytes (the Worker's limit, 32 MiB) closes its socket with 1009.
// `drop(id, role)` cuts a side's socket without a close frame, as a deploy or the network would.
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

type Peer = {
  send: (text: string) => void
  close: (code: number, reason: string) => void
  destroy: () => void
}
type Session = {
  created: number
  paired: boolean
  bridged?: boolean
  /** The paired CLI's resume token, and whether the session ended. */
  token?: string
  ended?: boolean
  page?: Peer
  cli?: Peer
}

const frame = (opcode: number, payload: Buffer): Buffer => {
  const n = payload.length
  const head =
    n < 126
      ? Buffer.from([0x80 | opcode, n])
      : n < 65536
        ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255])
        : Buffer.concat([Buffer.from([0x80 | opcode, 127]), bigLength(n)])
  return Buffer.concat([head, payload])
}
const bigLength = (n: number) => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64BE(BigInt(n))
  return b
}

/** The Worker's limit on a WebSocket message it receives, in bytes. */
export const MAX_MESSAGE = 32 * 1024 * 1024

/** One accepted socket: decodes the client's masked frames, sends the server's. */
const peer = (
  socket: Duplex,
  onText: (text: string) => void,
  onClose: (code: number) => void,
  maxMessage = MAX_MESSAGE,
): Peer => {
  let buffer = Buffer.alloc(0)
  let parts: Buffer[] = []
  let size = 0
  let closed = false
  const end = (code = 1006) => {
    if (closed) return
    closed = true
    socket.end()
    onClose(code)
  }
  socket.on('data', (data: Buffer) => {
    buffer = Buffer.concat([buffer, data])
    for (;;) {
      if (buffer.length < 2) return
      const fin = (buffer[0] as number) & 0x80
      const opcode = (buffer[0] as number) & 0x0f
      let n = (buffer[1] as number) & 0x7f
      let at = 2
      if (n === 126) {
        if (buffer.length < 4) return
        n = buffer.readUInt16BE(2)
        at = 4
      } else if (n === 127) {
        if (buffer.length < 10) return
        n = Number(buffer.readBigUInt64BE(2))
        at = 10
      }
      if (buffer.length < at + 4 + n) return
      const mask = buffer.subarray(at, at + 4)
      const payload = Buffer.from(buffer.subarray(at + 4, at + 4 + n))
      for (let i = 0; i < n; i++) payload[i] = (payload[i] as number) ^ (mask[i % 4] as number)
      buffer = buffer.subarray(at + 4 + n)
      if (opcode === 8) {
        if (!closed) socket.write(frame(8, payload.subarray(0, 2)))
        return end(payload.length >= 2 ? payload.readUInt16BE(0) : 1005)
      }
      if (opcode === 9) socket.write(frame(10, payload))
      if (opcode === 1 || opcode === 0) {
        parts.push(payload)
        size += payload.length
        if (size > maxMessage) {
          // As the Worker does: the message is too big, and the socket closes.
          socket.write(frame(8, Buffer.from([1009 >> 8, 1009 & 255])))
          return end(1009)
        }
        if (fin) {
          onText(Buffer.concat(parts).toString('utf8'))
          parts = []
          size = 0
        }
      }
    }
  })
  socket.on('close', () => end())
  socket.on('error', () => end())
  return {
    send: (text) => {
      if (!closed) socket.write(frame(1, Buffer.from(text)))
    },
    close: (code, reason) => {
      if (closed) return
      const payload = Buffer.concat([Buffer.from([code >> 8, code & 255]), Buffer.from(reason)])
      socket.write(frame(8, payload))
      setTimeout(end, 50)
    },
    destroy: () => socket.destroy(),
  }
}

export const startRelay = async (
  o: { ttlMs?: number; maxMessage?: number; alarm?: boolean } = {},
) => {
  const ttl = o.ttlMs ?? 10 * 60_000
  const sessions = new Map<string, Session>()
  /** Every frame the relay forwarded, as text: what it saw. */
  const seen: string[] = []
  const server = createServer((_, res) => {
    res.statusCode = 404
    res.end()
  })
  const sockets = new Set<Duplex>()
  server.on('upgrade', (req, socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    const url = new URL(req.url ?? '/', 'http://relay')
    const match = /^\/studio\/relay\/([a-z2-9]{20})$/.exec(url.pathname)
    const role = url.searchParams.get('role')
    if (!match || (role !== 'page' && role !== 'cli')) return socket.destroy()
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    const id = match[1] as string
    let s = sessions.get(id)
    if (!s) {
      const fresh: Session = { created: Date.now(), paired: false }
      s = fresh
      sessions.set(id, s)
      if (o.alarm)
        setTimeout(() => {
          if (fresh.paired) return
          sessions.delete(id)
          fresh.cli?.close(4001, 'expired')
          fresh.page?.close(4001, 'expired')
        }, ttl).unref()
    }
    const session = s
    const other = () => (role === 'page' ? session.cli : session.page)
    const me = peer(
      socket,
      (text) => {
        seen.push(text)
        const type = (JSON.parse(text) as { type?: string }).type
        if (role === 'cli' && type === 'bridge') session.bridged = true
        if (
          role === 'page' &&
          type === 'paired' &&
          session.cli &&
          session.bridged &&
          !session.paired
        ) {
          session.paired = true
          session.token = randomBytes(32).toString('hex')
          session.cli.send(JSON.stringify({ type: 'resume', token: session.token }))
        }
        other()?.send(text)
      },
      (code) => {
        if (session[role] !== me) return
        delete session[role]
        other()?.send(JSON.stringify({ type: `${role}-left` }))
        if (role === 'cli' && session.paired && code === 1000) {
          session.ended = true
          session.page?.close(4004, 'ended')
        }
      },
      o.maxMessage,
    )
    const resume = url.searchParams.get('resume')
    if (role === 'cli' && resume && session.paired) {
      if (resume !== session.token) return me.close(4002, 'used')
      if (session.ended) return me.close(4004, 'ended')
      session.cli?.destroy()
      session.cli = me
      me.send(JSON.stringify({ type: 'resumed' }))
      session.page?.send(JSON.stringify({ type: 'cli-joined' }))
      return
    }
    if (role === 'cli' && (session.paired || session.cli)) return me.close(4002, 'used')
    if (role === 'cli' && Date.now() - session.created > ttl) return me.close(4001, 'expired')
    if (role === 'page' && session.paired) return me.close(4003, 'taken')
    session[role]?.close(4000, 'replaced')
    session[role] = me
    if (role === 'cli') session.bridged = false
    if (role === 'cli') session.page?.send(JSON.stringify({ type: 'cli-joined' }))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    sessions,
    seen,
    drop: (id: string, role: 'page' | 'cli') => sessions.get(id)?.[role]?.destroy(),
    close: () =>
      new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => done())
      }),
  }
}
