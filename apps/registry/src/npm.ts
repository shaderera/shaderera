import { execFileSync, execSync } from 'node:child_process'

/**
 * Runs npm with `args`. On Windows npm is a .cmd, which Node only starts through a shell, so the
 * args are quoted into one command line (a shell must not split a path with spaces); elsewhere
 * npm starts without a shell.
 */
export const npm = (
  args: readonly string[],
  o: { cwd?: string; inherit?: boolean } = {},
): string => {
  const options = {
    encoding: 'utf8',
    ...(o.cwd ? { cwd: o.cwd } : {}),
    stdio: o.inherit ? 'inherit' : 'pipe',
  } as const
  return (
    (process.platform === 'win32'
      ? execSync(`npm ${args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(' ')}`, options)
      : execFileSync('npm', args, options)) ?? ''
  )
}

/** Packs the package in `dir` into the folder `into`: the tarball's name and the files in it. */
export const pack = (dir: string, into: string): { tgz: string; files: string[] } => {
  const out = npm(['pack', dir, '--pack-destination', into, '--json'])
  // A prepack script prints before the JSON.
  const [p] = JSON.parse(out.slice(out.search(/^\[/m)))
  return { tgz: p.filename, files: p.files.map((f: { path: string }) => f.path) }
}
