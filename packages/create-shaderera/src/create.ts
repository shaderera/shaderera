import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'

/** Never copied: installs, outputs and builds. */
const SKIP = new Set(['node_modules', 'out', '.shaderera', 'dist'])

/**
 * What a new project starts from (decision 0011): an empty film that is set up correctly. The
 * published package's `files/project/`, or this package's `project/` in the workspace.
 */
export const projectDir = (here: string): string => {
  const packed = join(here, '..', 'files', 'project')
  return existsSync(packed) ? packed : join(here, '..', 'project')
}

/** Copies a project's files, without installs, outputs or builds. */
export const copyProject = (from: string, target: string): void => {
  if (existsSync(target) && readdirSync(target).length > 0)
    throw new Error(`${target} is not empty.`)
  cpSync(from, target, {
    recursive: true,
    filter: (path) =>
      !relative(from, path)
        .split(sep)
        .some((part) => SKIP.has(part)),
  })
}

/** A project's `.mcp.json`: the MCP server, run as the Claude Code plugin runs it. */
export const MCP = {
  mcpServers: { shaderera: { command: 'npx', args: ['-y', 'shaderera', 'mcp'] } },
}

/**
 * Copies the starting project into `target`: its own name, and the workspace's `workspace:*`
 * versions pinned to this release's version.
 */
export const create = (o: {
  from: string
  target: string
  version: string
  /**
   * Files and folders every project gets at its root (the authoring guide, the agent notes, the
   * focused guides), by name; the project's own wins.
   */
  guides?: { [name: string]: string }
}): void => {
  copyProject(o.from, o.target)
  // npm never packs a .gitignore: without one, the first `git add .` takes node_modules and the renders.
  if (!existsSync(join(o.target, '.gitignore')))
    writeFileSync(join(o.target, '.gitignore'), 'node_modules/\nout/\n.shaderera/\n')
  // The MCP server for agents that read a project's .mcp.json (Claude Code, Cursor and others).
  if (!existsSync(join(o.target, '.mcp.json')))
    writeFileSync(join(o.target, '.mcp.json'), `${JSON.stringify(MCP, null, 2)}\n`)
  for (const [name, path] of Object.entries(o.guides ?? {})) {
    if (!existsSync(join(o.target, name))) cpSync(path, join(o.target, name), { recursive: true })
  }
  const file = join(o.target, 'package.json')
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  pkg.name = basename(resolve(o.target))
  for (const field of ['dependencies', 'devDependencies'] as const) {
    for (const [name, range] of Object.entries<string>(pkg[field] ?? {})) {
      if (range.startsWith('workspace:')) pkg[field][name] = `^${o.version}`
    }
  }
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
}
