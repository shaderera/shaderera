import type { Host, Source } from './protocol.ts'

/** Opens an imported entry module: its default export is an Open or a Source. */
export const openSource = async (module: unknown, host: Host): Promise<Source> => {
  const exported =
    module !== null && typeof module === 'object'
      ? (module as { default?: unknown }).default
      : undefined
  if (exported === undefined) throw new Error('The entry module has no default export.')
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
