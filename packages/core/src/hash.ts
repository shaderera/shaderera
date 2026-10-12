/** The SHA-256 of some bytes, as lowercase hex. */
export const sha256 = async (bytes: Uint8Array | Uint8ClampedArray): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
