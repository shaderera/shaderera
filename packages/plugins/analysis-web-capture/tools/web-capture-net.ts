// What a captured page may reach. tools/capture-web.ts starts Chrome with this proxy as its only
// way out (loopback included), so every request a page makes, from any frame or worker, comes
// through here. The proxy resolves each host once, refuses an address that is not public, and
// connects to the address it checked: a name cannot resolve to a public address for the check and
// to 127.0.0.1 for the connection.
//
// Refused: loopback, private networks (RFC 1918, IPv6 unique local), link-local, cloud metadata
// (169.254.169.254, metadata.google.internal…), and every other address that is not public
// unicast (this network, shared CGNAT space, documentation, benchmarking, multicast, reserved).
// An IPv6 address that carries an IPv4 one (mapped, NAT64, 6to4) is judged by that IPv4 address.
// `allowLocal` lets loopback, private and link-local addresses through, for a page on this
// machine or its network; cloud metadata stays refused.

import { lookup as dnsLookup } from 'node:dns/promises'
import { createServer, request } from 'node:http'
import { connect, isIP } from 'node:net'

/** Why an address is refused: its kind. */
export type Refusal = string

const v4 = (ip: string): number | undefined => {
  const parts = ip.split('.')
  if (parts.length !== 4) return undefined
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return undefined
    n = n * 256 + Number(p)
  }
  return n
}
const v4Text = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')

/** IPv4 ranges that are not public unicast, from IANA's special-purpose registry. */
const V4: [base: string, bits: number, kind: string][] = [
  ['0.0.0.0', 8, 'this network'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'shared address space'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'special-purpose'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, 'reserved'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
]
/** Cloud metadata services: AWS, GCP, Azure, Oracle, DigitalOcean (169.254.169.254), AWS ECS (169.254.170.2), Alibaba (100.100.100.200). */
const METADATA_V4 = new Set(['169.254.169.254', '169.254.170.2', '100.100.100.200'])
/** Names that reach a metadata service or this machine without asking DNS. */
const METADATA_NAMES = new Set(['metadata.google.internal', 'metadata.goog', 'metadata'])

const inV4 = (n: number, base: string, bits: number) =>
  bits === 0 || n >>> (32 - bits) === (v4(base) as number) >>> (32 - bits)

const kindV4 = (n: number): Refusal | undefined => {
  if (METADATA_V4.has(v4Text(n))) return 'cloud metadata'
  return V4.find(([base, bits]) => inV4(n, base, bits))?.[2]
}

/** An IPv6 address as eight 16-bit groups, or undefined when it is not one. */
const v6 = (text: string): number[] | undefined => {
  let ip = text.replace(/^\[|\]$/g, '')
  const zone = ip.indexOf('%')
  if (zone >= 0) ip = ip.slice(0, zone)
  if (isIP(ip) !== 6) return undefined
  // A dotted IPv4 tail is two groups.
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip)
  if (tail) {
    const n = v4(tail[1] as string)
    if (n === undefined) return undefined
    ip = `${ip.slice(0, tail.index)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const [head, rest] = ip.split('::') as [string, string | undefined]
  const a = head ? head.split(':') : []
  const b = rest === undefined ? [] : rest ? rest.split(':') : []
  const fill = rest === undefined ? 0 : 8 - a.length - b.length
  const groups = [...a, ...Array(fill).fill('0'), ...b].map((g) => Number.parseInt(g, 16))
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : undefined
}

/** Whether the first `bits` bits of `g` are those of `prefix` (groups). */
const inV6 = (g: number[], prefix: number[], bits: number) => {
  for (let i = 0; i < 8 && bits > 0; i++, bits -= 16) {
    const mask = bits >= 16 ? 0xffff : (0xffff << (16 - bits)) & 0xffff
    if (((g[i] as number) & mask) !== ((prefix[i] ?? 0) & mask)) return false
  }
  return true
}
const embedded = (hi: number, lo: number) => ((hi << 16) | lo) >>> 0

const kindV6 = (g: number[]): Refusal | undefined => {
  const at = (i: number) => g[i] as number
  if (g.every((x) => x === 0)) return 'unspecified'
  if (g.slice(0, 7).every((x) => x === 0) && at(7) === 1) return 'loopback'
  // IPv4-mapped ::ffff:a.b.c.d and NAT64 64:ff9b::a.b.c.d: the IPv4 address decides.
  if (inV6(g, [0, 0, 0, 0, 0, 0xffff], 96) || inV6(g, [0x64, 0xff9b], 96)) {
    const n = embedded(at(6), at(7))
    const kind = kindV4(n)
    return kind && `${kind} (${v4Text(n)})`
  }
  // 6to4 2002:a.b.c.d::/48 carries its IPv4 address in groups 1 and 2.
  if (at(0) === 0x2002) {
    const n = embedded(at(1), at(2))
    const kind = kindV4(n)
    return kind && `${kind} (${v4Text(n)})`
  }
  if (
    at(0) === 0xfd00 &&
    at(1) === 0x0ec2 &&
    g.slice(2, 7).every((x) => x === 0) &&
    at(7) === 0x254
  )
    return 'cloud metadata'
  if (inV6(g, [0x64, 0xff9b, 1], 48)) return 'private'
  if (inV6(g, [0x100], 64)) return 'discard-only'
  if (inV6(g, [0x2001, 0xdb8], 32) || inV6(g, [0x3fff], 20)) return 'documentation'
  if (inV6(g, [0x2001], 23)) return 'special-purpose'
  if (inV6(g, [0xfc00], 7)) return 'private (unique local)'
  if (inV6(g, [0xfe80], 10)) return 'link-local'
  if (inV6(g, [0xfec0], 10)) return 'site-local'
  if (inV6(g, [0xff00], 8)) return 'multicast'
  // Public unicast is 2000::/3; the rest is reserved, the old IPv4-compatible ::/96 among it.
  if (!inV6(g, [0x2000], 3)) return 'reserved'
  return undefined
}

/**
 * Why an IP address is refused (its kind: `loopback`, `private`, `link-local`, `cloud
 * metadata`…), or undefined for a public unicast address. Throws on what is not an IP address.
 */
export const refusedAddress = (ip: string): Refusal | undefined => {
  const n = v4(ip)
  if (n !== undefined) return kindV4(n)
  const g = v6(ip)
  if (g) return kindV6(g)
  throw new Error(`${JSON.stringify(ip)} is not an IP address`)
}

/** Kinds that `allowLocal` lets through: this machine and its network. */
const LOCAL = /^(loopback|private|link-local|unspecified|this network|shared address space)\b/

/** Whether `allowLocal` lets an address of this kind through. Cloud metadata never. */
export const localKind = (kind: Refusal) => !kind.includes('cloud metadata') && LOCAL.test(kind)

/** Why a host name is refused before DNS is asked: names that reach this machine or metadata. */
export const refusedName = (host: string): Refusal | undefined => {
  const name = host.toLowerCase().replace(/\.$/, '')
  if (name === 'localhost' || name.endsWith('.localhost')) return 'loopback'
  if (METADATA_NAMES.has(name)) return 'cloud metadata'
  return undefined
}

export type Lookup = (host: string) => Promise<{ address: string; family: number }[]>
const systemLookup: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true })

/** A host checked: the addresses a connection may go to, or why it is refused. */
export type Checked =
  | { addresses: { address: string; family: number }[] }
  | { refused: string; address?: string; kind: Refusal }

/**
 * Resolves `host` (a name, or an IP address with or without brackets) and checks every address it
 * resolves to: one refused address refuses the host, since the connection could go to any. The
 * connection then goes to these addresses only, so it goes where the check looked.
 */
export const checkHost = async (
  host: string,
  { allowLocal = false, lookup = systemLookup }: { allowLocal?: boolean; lookup?: Lookup } = {},
): Promise<Checked> => {
  const bare = host.replace(/^\[|\]$/g, '')
  const family = isIP(bare.replace(/%.*$/, ''))
  const name = family ? undefined : refusedName(bare)
  const pass = (kind: Refusal) => allowLocal && localKind(kind)
  if (name && !pass(name)) return { refused: `${host} is a ${name} name`, kind: name }
  let addresses: { address: string; family: number }[]
  if (family) addresses = [{ address: bare, family }]
  else {
    try {
      addresses = await lookup(bare)
    } catch (e) {
      return { refused: `${host} does not resolve (${(e as Error).message})`, kind: 'unresolved' }
    }
  }
  if (addresses.length === 0) return { refused: `${host} does not resolve`, kind: 'unresolved' }
  for (const a of addresses) {
    const kind = refusedAddress(a.address)
    if (kind && !pass(kind))
      return {
        refused:
          a.address === bare
            ? `${host} is a ${kind} address`
            : `${host} is ${a.address}, a ${kind} address`,
        address: a.address,
        kind,
      }
  }
  return { addresses }
}

/** A lookup for net.connect and http.request that answers with the checked addresses only. */
const pinned =
  (addresses: { address: string; family: number }[]) =>
  (
    _host: string,
    opts: { all?: boolean },
    done: (e: Error | null, a: string | { address: string; family: number }[], f?: number) => void,
  ) => {
    const first = addresses[0] as { address: string; family: number }
    if (opts.all) done(null, addresses)
    else done(null, first.address, first.family)
  }

/** `host:port` as a CONNECT request names it, IPv6 in brackets. */
const hostPort = (target: string) => {
  const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(target)
  return m ? { host: m[1] as string, port: Number(m[2]) } : undefined
}

/** A request the proxy refused: what it was for, and why. */
export type Refused = { where: string; reason: string }

/**
 * An HTTP proxy on 127.0.0.1 for Chrome's --proxy-server: plain requests are forwarded, CONNECT
 * (https, wss) tunnelled, each to the address checkHost passed. A refused request gets a 403 and
 * is handed to `onRefused`. `close` ends every connection.
 */
export const startProxy = async ({
  allowLocal,
  lookup,
  onRefused,
}: {
  allowLocal: boolean
  lookup?: Lookup
  onRefused: (r: Refused) => void
}) => {
  const check = (host: string) => checkHost(host, { allowLocal, lookup })
  const why = (c: { refused: string; kind: string }) =>
    c.kind === 'unresolved' || !localKind(c.kind)
      ? `refused: ${c.refused}`
      : `refused: ${c.refused}; --allow-local lets a page on this machine or its network through`
  const server = createServer(async (req, res) => {
    let url: URL
    try {
      url = new URL(req.url ?? '')
    } catch {
      res.writeHead(400).end()
      return
    }
    if (url.protocol !== 'http:') {
      res.writeHead(400).end()
      return
    }
    const c = await check(url.hostname)
    if ('refused' in c) {
      onRefused({ where: url.href, reason: why(c) })
      res.writeHead(403, { 'content-type': 'text/plain' }).end(why(c))
      return
    }
    const headers = { ...req.headers }
    delete headers['proxy-connection']
    delete headers['proxy-authorization']
    const up = request(
      {
        // The connection goes to the checked addresses, one after another until one answers.
        createConnection: () =>
          connect({
            host: url.hostname.replace(/^\[|\]$/g, ''),
            port: Number(url.port || 80),
            lookup: pinned(c.addresses),
            autoSelectFamily: true,
          }),
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
        setHost: false,
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.statusMessage, r.rawHeaders)
        r.pipe(res)
      },
    )
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(up)
  })
  const tunnel = async (
    target: string,
    socket: import('node:stream').Duplex,
    head: Buffer,
    where: string,
    opening?: string,
  ) => {
    socket.on('error', () => {})
    const hp = hostPort(target)
    if (!hp) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    const c = await check(hp.host)
    if ('refused' in c) {
      onRefused({ where, reason: why(c) })
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    const up = connect({
      host: hp.host.replace(/^\[|\]$/g, ''),
      port: hp.port,
      lookup: pinned(c.addresses),
      autoSelectFamily: true,
    })
    up.on('error', () => socket.destroy())
    socket.on('close', () => up.destroy())
    up.once('connect', () => {
      if (opening === undefined) socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      else up.write(opening)
      if (head.length > 0) up.write(head)
      up.pipe(socket)
      socket.pipe(up)
    })
  }
  // https and wss: a tunnel to host:port.
  server.on('connect', (req, socket, head) => {
    const target = req.url ?? ''
    void tunnel(target, socket, head, target)
  })
  // ws:// sent to the proxy as a plain upgrade: the request line and headers go on as they came.
  server.on('upgrade', (req, socket, head) => {
    let url: URL
    try {
      url = new URL(req.url ?? '')
    } catch {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    const lines = [`${req.method} ${url.pathname}${url.search} HTTP/1.1`]
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      if (!/^proxy-/i.test(req.rawHeaders[i] as string))
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
    const port = url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80)
    void tunnel(`${url.hostname}:${port}`, socket, head, url.href, `${lines.join('\r\n')}\r\n\r\n`)
  })
  const sockets = new Set<import('node:net').Socket>()
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the proxy has no port')
  return {
    port: address.port,
    close: () =>
      new Promise<void>((done) => {
        for (const s of sockets) s.destroy()
        server.close(() => done())
      }),
  }
}
