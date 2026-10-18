// The web player's bridge rules (docs/player.md), apart from the page so they can be tested.

/** The meta in runner.html that lists the origins allowed to frame the player and get its port. */
export const PARENTS_META = 'shaderera-parents'

/** The origins allowed by default: the site the player is shared to. */
export const DEFAULT_PARENTS: readonly string[] = ['https://shaderera.com']

/** An origin as a page sees `event.origin`: scheme, host and port, no path, no slash. */
export const isOrigin = (s: string): boolean => {
  try {
    return new URL(s).origin === s
  } catch {
    return false
  }
}

/**
 * The one origin the bridge hands the port to: the one `?parent=` names when it is allowed, else
 * the first allowed. The browser delivers the port only if the framing page really has that
 * origin, so naming another one gets a page nothing.
 */
export const parentOrigin = (
  allowed: readonly string[],
  asked: string | null,
): string | undefined => (asked !== null && allowed.includes(asked) ? asked : allowed[0])

/**
 * A viewer's file for a clip param, taken from a message only when it comes from the framing
 * window at the parent's origin and names a `local:` clip; anything else is undefined.
 */
export const fileFrom = (
  e: { source: unknown; origin: string; data: unknown },
  parentWindow: unknown,
  origin: string | undefined,
): { name: string; file: Blob } | undefined => {
  if (origin === undefined || e.source !== parentWindow || e.origin !== origin) return undefined
  const d = e.data as { shaderera?: unknown; name?: unknown; file?: unknown } | null
  if (d?.shaderera !== 'file' || typeof d.name !== 'string' || !d.name.startsWith('local:'))
    return undefined
  return d.file instanceof Blob ? { name: d.name, file: d.file } : undefined
}
