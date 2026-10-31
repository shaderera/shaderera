import type { Host, Source } from './protocol.ts'

/**
 * Opens an imported entry module: its default export is an Open or a Source. `entry` names the
 * module in the error for a missing default export (the manifest's entry, `src/composition.ts`).
 */
export const openSource = async (
  module: unknown,
  host: Host,
  entry = 'The entry module',
): Promise<Source> => {
  const exported =
    module !== null && typeof module === 'object'
      ? (module as { default?: unknown }).default
      : undefined
  if (exported === undefined)
    throw new Error(`${entry} has no default export: end it with export default open.`)
  const source: unknown = typeof exported === 'function' ? await exported(host) : exported
  if (
    source === null ||
    typeof source !== 'object' ||
    typeof (source as { render?: unknown }).render !== 'function'
  ) {
    throw new Error(
      'The entry module did not give a Source: it needs a render(t, options) function.',
    )
  }
  return source as Source
}
