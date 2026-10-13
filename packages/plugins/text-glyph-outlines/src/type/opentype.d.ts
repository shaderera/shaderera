// The part of opentype.js 2.0.0 that outlines.ts uses: the package ships no types. Remove this
// file if the project installs a fuller declaration of its own.

declare module 'opentype.js' {
  export type PathCommand =
    | { type: 'M'; x: number; y: number }
    | { type: 'L'; x: number; y: number }
    | { type: 'Q'; x1: number; y1: number; x: number; y: number }
    | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
    | { type: 'Z' }

  export interface Path {
    commands: PathCommand[]
  }

  export interface Glyph {
    index: number
    name?: string | null
    unicode?: number
    unicodes: number[]
    advanceWidth?: number
    /** In font units, y up. */
    path: Path
  }

  export interface Font {
    unitsPerEm: number
    ascender: number
    descender: number
    outlinesFormat: 'truetype' | 'cff'
    glyphs: { length: number; get(index: number): Glyph | undefined }
    /** Present for a variable font. */
    variation?: {
      getTransform(glyph: Glyph, coords?: Record<string, number>): Glyph
      get(): Record<string, number>
    }
    position: {
      getDefaultScriptName(): string
      getKerningTables(script: string, language?: string): unknown
      getKerningValue(tables: unknown, left: number, right: number): number
    }
    stringToGlyphs(text: string, options?: { features?: Record<string, boolean> }): Glyph[]
    getKerningValue(left: Glyph, right: Glyph): number
  }

  export function parse(buffer: ArrayBuffer, options?: { lowMemory?: boolean }): Font

  const opentype: { parse: typeof parse }
  export default opentype
}
