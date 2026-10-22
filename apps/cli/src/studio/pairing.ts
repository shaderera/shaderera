// A studio session's pairing (docs/studio.md): its id, the relay's address and close codes, and the
// key both sides derive. WebCrypto only: ECDH P-256, HKDF-SHA-256, AES-256-GCM.

/** The characters of a studio session id: no 0/o, 1/i/l. */
export const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
export const ID_LENGTH = 20

/** A new studio session id: 20 characters of ID_ALPHABET, uniformly (about 99 bits). */
export const makeId = (): string => {
  const out: string[] = []
  while (out.length < ID_LENGTH) {
    // 248 is the largest multiple of 31 under 256: bytes above it would favour the first letters.
    for (const b of crypto.getRandomValues(new Uint8Array(ID_LENGTH * 2)))
      if (b < 248 && out.length < ID_LENGTH) out.push(ID_ALPHABET[b % 31] as string)
  }
  return out.join('')
}

export const isId = (id: string): boolean =>
  id.length === ID_LENGTH && [...id].every((c) => ID_ALPHABET.includes(c))

/**
 * The pairing nonce: 16 random bytes, base64url. The CLI opens the page with it in the address's
 * fragment, which no server sees, and pairs only with a page that proves it holds it.
 */
export const makeNonce = (): string => toBase64url(crypto.getRandomValues(new Uint8Array(16)))

/**
 * The page a studio session opens: `<site>/studio/<id>`, with `#<nonce>` for the CLI's own, and
 * `?from=web` when the session began on the web (`--connect`), as `/studio`'s own page says.
 */
export const pageUrl = (site: string, id: string, nonce?: string, web = false): string =>
  `${site}/studio/${id}${web ? '?from=web' : ''}${nonce ? `#${nonce}` : ''}`

/** The relay's WebSocket for one side: `wss://<site>/studio/relay/<id>?role=<role>`. */
export const relayUrl = (site: string, id: string, role: 'cli' | 'page'): string =>
  `${site.replace(/^http/, 'ws')}/studio/relay/${id}?role=${role}`

/** The relay's close codes. `ended`: a resume token once the session is over. */
export const CLOSE = { expired: 4001, used: 4002, taken: 4003, ended: 4004 } as const

/** HKDF's info: names the protocol's version, so a v1 key never opens a v0 box. */
export const INFO = 'shaderera-studio-v1'

const utf8 = new TextEncoder()

export const toBase64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')
export const fromBase64url = (text: string): Uint8Array =>
  new Uint8Array(Buffer.from(text, 'base64url'))

/** An ECDH P-256 key pair, and its public key raw (uncompressed, 65 bytes) in base64url. */
export const keyPair = async (): Promise<{ privateKey: CryptoKey; pub: string }> => {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveBits',
  ])) as CryptoKeyPair
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  return { privateKey: pair.privateKey, pub: toBase64url(raw) }
}

/**
 * The session key: ECDH of our private key and the other side's public key, then HKDF-SHA-256
 * with salt = the id's UTF-8 bytes and info INFO, as an AES-256-GCM key.
 */
export const sessionKey = async (
  privateKey: CryptoKey,
  theirPub: string,
  id: string,
): Promise<CryptoKey> => {
  const theirs = await crypto.subtle.importKey(
    'raw',
    fromBase64url(theirPub) as Uint8Array<ArrayBuffer>,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirs }, privateKey, 256)
  const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8.encode(id), info: utf8.encode(INFO) },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** `value` as JSON, sealed with AES-GCM under a fresh 12-byte iv; both base64url. */
export const seal = async (
  key: CryptoKey,
  value: unknown,
): Promise<{ iv: string; box: string }> => {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const box = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    utf8.encode(JSON.stringify(value)),
  )
  return { iv: toBase64url(iv), box: toBase64url(new Uint8Array(box)) }
}

/**
 * Bytes sealed as they are (a file's chunk), with `aad` bound to them: a box opens only under the
 * same `aad`, so the relay can neither reorder chunks nor move one to another request.
 */
export const sealBytes = async (
  key: CryptoKey,
  bytes: Uint8Array,
  aad: string,
): Promise<{ iv: string; box: string }> => {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const box = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8.encode(aad) },
    key,
    bytes as Uint8Array<ArrayBuffer>,
  )
  return { iv: toBase64url(iv), box: toBase64url(new Uint8Array(box)) }
}

/** The bytes `sealBytes` sealed under `aad`; throws when anything does not match. */
export const unsealBytes = async (
  key: CryptoKey,
  m: { iv: string; box: string },
  aad: string,
): Promise<Uint8Array> =>
  new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64url(m.iv) as Uint8Array<ArrayBuffer>,
        additionalData: utf8.encode(aad),
      },
      key,
      fromBase64url(m.box) as Uint8Array<ArrayBuffer>,
    ),
  )

/** The JSON value a sealed box holds; throws when the key, iv or box do not match. */
export const unseal = async <T = unknown>(
  key: CryptoKey,
  m: { iv: string; box: string },
): Promise<T> => {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64url(m.iv) as Uint8Array<ArrayBuffer> },
    key,
    fromBase64url(m.box) as Uint8Array<ArrayBuffer>,
  )
  return JSON.parse(new TextDecoder().decode(plain)) as T
}
