/**
 * The code points a TrueType/OpenType font maps to a glyph, from its `cmap` table (formats 4 and
 * 12, Unicode or Windows encodings). A TrueType collection reads its first font.
 */
export const cmapCodePoints = (bytes: Uint8Array): Set<number> => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let font = 0
  if (view.getUint32(0) === 0x74746366) font = view.getUint32(12) // 'ttcf'
  const tables = view.getUint16(font + 4)
  let cmap = -1
  for (let i = 0; i < tables; i++) {
    const record = font + 12 + i * 16
    if (view.getUint32(record) === 0x636d6170) cmap = view.getUint32(record + 8) // 'cmap'
  }
  if (cmap < 0) throw new Error('The font has no cmap table.')
  const out = new Set<number>()
  const subtables = view.getUint16(cmap + 2)
  for (let i = 0; i < subtables; i++) {
    const platform = view.getUint16(cmap + 4 + i * 8)
    const encoding = view.getUint16(cmap + 6 + i * 8)
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10))
    if (!unicode) continue
    const at = cmap + view.getUint32(cmap + 8 + i * 8)
    const format = view.getUint16(at)
    if (format === 4) {
      const segments = view.getUint16(at + 6) / 2
      const ends = at + 14
      const starts = ends + segments * 2 + 2
      const deltas = starts + segments * 2
      const offsets = deltas + segments * 2
      for (let s = 0; s < segments; s++) {
        const end = view.getUint16(ends + s * 2)
        const start = view.getUint16(starts + s * 2)
        const delta = view.getUint16(deltas + s * 2)
        const offset = view.getUint16(offsets + s * 2)
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let glyph: number
          if (offset === 0) glyph = (c + delta) & 0xffff
          else {
            const g = view.getUint16(offsets + s * 2 + offset + (c - start) * 2)
            glyph = g === 0 ? 0 : (g + delta) & 0xffff
          }
          if (glyph !== 0) out.add(c)
        }
      }
    } else if (format === 12) {
      const groups = view.getUint32(at + 12)
      for (let g = 0; g < groups; g++) {
        const group = at + 16 + g * 12
        const start = view.getUint32(group)
        const end = view.getUint32(group + 4)
        const glyph = view.getUint32(group + 8)
        for (let c = start; c <= end; c++) if (glyph + (c - start) !== 0) out.add(c)
      }
    }
  }
  return out
}

/** The characters of `text` (excluding whitespace and controls) the font does not map. */
export const missingGlyphs = (text: string, codePoints: ReadonlySet<number>): string[] => {
  const missing = new Set<string>()
  for (const ch of text) {
    const c = ch.codePointAt(0) as number
    if (/\s/.test(ch) || c < 0x20 || c === 0x200b || c === 0x200c || c === 0x200d) continue
    if (!codePoints.has(c)) missing.add(ch)
  }
  return [...missing]
}
