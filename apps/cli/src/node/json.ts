import { readFileSync } from 'node:fs'

/**
 * JSON a person may have written (shaderera.json, requirements.json, package.json): a leading BOM
 * (U+FEFF), which PowerShell's `Set-Content -Encoding utf8` writes, is not JSON and goes first.
 */
export const jsonOf = <T = unknown>(text: string): T =>
  JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

/** A project's JSON file, read with jsonOf. */
export const readJson = <T = unknown>(file: string): T => jsonOf<T>(readFileSync(file, 'utf8'))
