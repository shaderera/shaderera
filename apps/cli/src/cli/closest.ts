/** The edits (insert, delete, replace) that turn a into b. */
const distance = (a: string, b: string): number => {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(
        (row[j] as number) + 1,
        (next[j - 1] as number) + 1,
        (row[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    row = next
  }
  return row[b.length] as number
}

/**
 * The name among `among` (commands, flags, variants) a mistyped one most likely meant: the nearest
 * within two edits. Its own module: main.ts, which runs the CLI, is never imported back.
 */
export const closest = (name: string, among: readonly string[]): string | undefined => {
  const [best] = among
    .map((c) => ({ c, d: distance(name, c) }))
    .filter((x) => x.d <= 2)
    .sort((x, y) => x.d - y.d)
  return best?.c
}
