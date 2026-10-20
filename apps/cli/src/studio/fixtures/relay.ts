// A stand-in for the site's studio relay (docs/studio.md, "The relay"), in memory, for tests: a
// WebSocket server of its own (RFC 6455, text and close frames only) at
// /studio/relay/<id>?role=page|cli, with the relay's rules:
// - an id not paired within `ttlMs` of its first connection is expired: a CLI gets 4001;
// - once the page sends `paired`, the id is used: a CLI gets 4002 and a page 4003;
// - before that, a second CLI gets 4002 too, and a second page replaces the first (a reload);
// - `cli-joined` goes to the page when a CLI connects; `page-left`/`cli-left` when a side closes;
// - every other frame goes to the other side as it is.
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

type Peer = { send: (text: string) => void; close: (code: number, reason: string) => void }
type Session = { created: number; paired: boolean; page?: Peer; cli?: Peer }

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

/** One accepted socket: decodes the client's masked frames, sends the server's. */
const peer = (socket: Duplex, onText: (text: string) => void, onClose: () => void): Peer => {
  let buffer = Buffer.alloc(0)
  let parts: Buffer[] = []
  let closed = false
  const end = () => {
    if (closed) return
    closed = true
    socket.end()
    onClose()
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
        return end()
      }
      if (opcode === 9) socket.write(frame(10, payload))
      if (opcode === 1 || opcode === 0) {
        parts.push(payload)
        if (fin) {
          onText(Buffer.concat(parts).toString('utf8'))
          parts = []
        }
      }
    }
  })
  socket.on('close', end)
  socket.on('error', end)
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
  }
}

export const startRelay = async (o: { ttlMs?: number } = {}) => {
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
    const match = /^\/studio\/relay\/([a-z2-9]{6})$/.exec(url.pathname)
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
      s = { created: Date.now(), paired: false }
      sessions.set(id, s)
    }
    const session = s
    const other = () => (role === 'page' ? session.cli : session.page)
    const me = peer(
      socket,
      (text) => {
        seen.push(text)
        if (role === 'page' && (JSON.parse(text) as { type?: string }).type === 'paired')
          session.paired = true
        other()?.send(text)
      },
      () => {
        if (session[role] !== me) return
        delete session[role]
        other()?.send(JSON.stringify({ type: `${role}-left` }))
      },
    )
    if (role === 'cli' && (session.paired || session.cli)) return me.close(4002, 'used')
    if (role === 'cli' && Date.now() - session.created > ttl) return me.close(4001, 'expired')
    if (role === 'page' && session.paired) return me.close(4003, 'taken')
    session[role]?.close(4000, 'replaced')
    session[role] = me
    if (role === 'cli') session.page?.send(JSON.stringify({ type: 'cli-joined' }))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    sessions,
    seen,
    close: () =>
      new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => done())
      }),
  }
}
