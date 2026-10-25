import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse, sep } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { create, projectDir } from './create.ts'

/** A new empty temp folder, removed after the test that made it. */
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'shaderera-create-'))
  after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
  return dir
}

const from = projectDir(import.meta.dirname)
const repo = join(import.meta.dirname, '..', '..', '..')
const guides = {
  'AUTHORING.md': join(repo, 'docs', 'authoring.md'),
  'AGENTS.md': join(import.meta.dirname, '..', 'guide', 'AGENTS.md'),
  'CLAUDE.md': join(import.meta.dirname, '..', 'guide', 'CLAUDE.md'),
  guides: join(repo, 'docs', 'guides'),
}

test('create copies the empty project as an ordinary project', () => {
  const target = join(temp(), 'my-film')
  create({ from, target, version: '0.1.0' })
  const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'my-film')
  // All rights reserved until the person chooses a licence: share needs one.
  assert.equal(pkg.license, 'UNLICENSED')
  assert.equal(pkg.dependencies['@shaderera/core'], '^0.1.0')
  assert.equal(pkg.devDependencies.shaderera, '^0.1.0')
  assert.equal(pkg.devDependencies.webgpu, '0.6.2')
  assert.equal(pkg.devDependencies.three, undefined)
  assert.ok(existsSync(join(target, 'shaderera.json')))
  assert.ok(existsSync(join(target, 'src', 'composition.ts')))
  assert.ok(!existsSync(join(target, 'node_modules')))
  assert.match(readFileSync(join(target, '.gitignore'), 'utf8'), /^node_modules\/$/m)
  const mcp = JSON.parse(readFileSync(join(target, '.mcp.json'), 'utf8'))
  assert.deepEqual(mcp.mcpServers.shaderera, { command: 'npx', args: ['-y', 'shaderera', 'mcp'] })
  assert.throws(() => create({ from, target, version: '0.1.0' }), /not empty/)
})

test('every created project gets the authoring guide, the agent notes and the guides', () => {
  const target = join(temp(), 'film')
  create({ from, target, version: '0.3.0', guides })
  assert.match(readFileSync(join(target, 'CLAUDE.md'), 'utf8'), /@AGENTS.md/)
  assert.match(readFileSync(join(target, 'guides', 'typography.md'), 'utf8'), /^# Typography/)
  assert.match(readFileSync(join(target, 'AUTHORING.md'), 'utf8'), /^# Authoring a Shaderera film/)
  assert.match(readFileSync(join(target, 'AGENTS.md'), 'utf8'), /read `AUTHORING.md`/)
})

test('the empty project imports only the stable entries (docs/api.md), and no look', () => {
  const allowed = new Set(['@shaderera/core', '@shaderera/core/gpu'])
  const wrong: string[] = []
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(ts|tsx|js|jsx|mts)$/.test(entry.name))
        for (const [, spec] of readFileSync(path, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g))
          if (!allowed.has(spec as string)) wrong.push(`${path}: ${spec}`)
    }
  }
  walk(join(from, 'src'))
  assert.deepEqual(wrong, [])
})

test('the Claude Code plugin has no version, so every change reaches users', () => {
  // Claude Code caches a plugin by version. With none set it uses the commit, so a skill change
  // reaches `claude plugin update` without a bump; a fixed version would hold users on old skills.
  const read = (...p: string[]) => JSON.parse(readFileSync(join(repo, ...p), 'utf8'))
  assert.equal(read('plugins', 'shaderera', '.claude-plugin', 'plugin.json').version, undefined)
  assert.equal(read('.claude-plugin', 'marketplace.json').plugins[0].version, undefined)
})

test('the Claude Code plugin declares the MCP server, started by its launcher', () => {
  const plugin = JSON.parse(
    readFileSync(join(repo, 'plugins', 'shaderera', '.claude-plugin', 'plugin.json'), 'utf8'),
  )
  assert.deepEqual(plugin.mcpServers.shaderera, {
    command: 'node',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands it, not JS
    args: ['${CLAUDE_PLUGIN_ROOT}/mcp.mjs'],
  })
  assert.match(
    readFileSync(join(repo, 'plugins', 'shaderera', 'mcp.mjs'), 'utf8'),
    /'-y', 'shaderera', 'mcp'/,
  )
})

/** The plugin's MCP launcher (plain JS in the plugin, so typed here). */
const launcher = (): Promise<{
  npxLock: (env: Record<string, string | undefined>, platform: string) => string
  clearStaleLock: (lock: string, staleMs?: number) => Promise<'none' | 'released' | 'removed'>
}> => import(pathToFileURL(join(repo, 'plugins', 'shaderera', 'mcp.mjs')).href)

test("the launcher finds npx's lock for shaderera in the npm cache", async () => {
  const { npxLock } = await launcher()
  // libnpmexec names the folder by the first 16 hex of the sha512 of the package list.
  assert.equal(
    npxLock({ npm_config_cache: join('c', 'cache') }, 'linux'),
    join('c', 'cache', '_npx', '30b46d2cfb6f1c28', 'concurrency.lock'),
  )
  assert.equal(
    npxLock({ LOCALAPPDATA: join('c', 'local') }, 'win32'),
    join('c', 'local', 'npm-cache', '_npx', '30b46d2cfb6f1c28', 'concurrency.lock'),
  )
})

test('the launcher removes a lock nothing touches, and waits for one that is held', async () => {
  const { clearStaleLock } = await launcher()
  const lock = join(temp(), 'concurrency.lock')
  assert.equal(await clearStaleLock(lock), 'none')

  // Left by a killed npx: untouched for longer than the stale time.
  mkdirSync(lock)
  const old = (Date.now() - 10_000) / 1000
  utimesSync(lock, old, old)
  assert.equal(await clearStaleLock(lock, 1_000), 'removed')
  assert.equal(existsSync(lock), false)

  // Held by a live npx: touched every 200 ms, then released.
  mkdirSync(lock)
  const touch = setInterval(() => utimesSync(lock, new Date(), new Date()), 200)
  setTimeout(() => {
    clearInterval(touch)
    rmSync(lock, { recursive: true })
  }, 1_500)
  assert.equal(await clearStaleLock(lock, 1_000), 'released')
})

/** Runs the create-shaderera bin with these arguments in a new temp folder. */
const bin = (...args: string[]) =>
  spawnSync(
    process.execPath,
    [join(import.meta.dirname, '..', 'bin', 'create-shaderera.js'), ...args],
    { cwd: temp(), encoding: 'utf8' },
  )

test('--help and -h print the usage and exit 0, making nothing', () => {
  for (const flag of ['--help', '-h']) {
    const { status, stdout, stderr } = bin(flag)
    assert.equal(status, 0, stderr)
    assert.match(stdout, /^Usage: npm create shaderera@latest \[dir\]/)
    assert.match(stdout, /--help/)
    assert.match(stdout, /Docs: /)
    assert.doesNotMatch(stdout, /Created/)
  }
})

test('a new project holds no copy of the skills: the plugin or `npx skills add` keeps the one copy', () => {
  // A copy in .claude/skills/ is frozen when the project is made and drifts from the plugin's.
  const cwd = temp()
  const { status, stderr } = spawnSync(
    process.execPath,
    [join(import.meta.dirname, '..', 'bin', 'create-shaderera.js'), 'film'],
    { cwd, encoding: 'utf8' },
  )
  assert.equal(status, 0, stderr)
  assert.ok(existsSync(join(cwd, 'film', 'AGENTS.md')))
  assert.ok(existsSync(join(cwd, 'film', '.mcp.json')))
  assert.ok(!existsSync(join(cwd, 'film', '.claude')))
  assert.match(readFileSync(join(cwd, 'film', 'AGENTS.md'), 'utf8'), /npx skills add/)
})

/**
 * A new empty folder directly under the temp folder's drive root (`C:\shaderera-create-…`), where
 * people make projects on Windows and where Node's `fs.cpSync` crashed into it (#349). Undefined
 * when the root is not writable (a Linux `/`).
 */
const rootFolder = (name = 'shaderera-create-') => {
  const root = parse(tmpdir()).root
  try {
    const dir = mkdtempSync(join(root, name))
    after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
    return dir
  } catch {
    return undefined
  }
}

/**
 * Runs the bin as npm's Windows shim does: `node "%dp0%\..\create-shaderera\bin\…js"`, a path
 * that still holds its `..`.
 */
const run = (cwd: string, ...args: string[]) =>
  spawnSync(
    process.execPath,
    [[import.meta.dirname, '..', 'bin', 'create-shaderera.js'].join(sep), ...args],
    { cwd, encoding: 'utf8' },
  )

test('`.` in an empty folder makes the project there, named after the folder', (t) => {
  const cwd = rootFolder('Shaderera Create ')
  if (!cwd) return t.skip('the drive root is not writable')
  const { status, stdout, stderr } = run(cwd, '.')
  assert.equal(status, 0, stderr)
  assert.match(stdout, /^Created shaderera-create-/)
  assert.ok(existsSync(join(cwd, 'src', 'composition.ts')))
  assert.ok(existsSync(join(cwd, 'AGENTS.md')))
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
  assert.match(pkg.name, /^shaderera-create-[a-z0-9]+$/)
})

test('the absolute path of an empty folder makes the project there', (t) => {
  const cwd = rootFolder()
  if (!cwd) return t.skip('the drive root is not writable')
  const { status, stdout, stderr } = run(cwd, cwd)
  assert.equal(status, 0, stderr)
  assert.match(stdout, /^Created /)
  assert.ok(existsSync(join(cwd, 'src', 'composition.ts')))
})

test('a folder that is not empty is refused with its path and exit 1, and nothing is written', () => {
  const cwd = temp()
  writeFileSync(join(cwd, 'notes.txt'), 'mine\n')
  const { status, stdout, stderr } = run(cwd, '.')
  assert.equal(status, 1)
  assert.equal(stdout, '')
  assert.match(stderr, /is not empty/)
  assert.ok(stderr.includes(cwd), stderr)
  assert.deepEqual(readdirSync(cwd), ['notes.txt'])
})

test('a new folder named on the command line gets the project and a cd in the next steps', () => {
  const cwd = temp()
  const { status, stdout, stderr } = run(cwd, 'My Film')
  assert.equal(status, 0, stderr)
  assert.match(stdout, /^Created My Film\. Next:\n\n {2}cd My Film\n/)
  assert.equal(
    JSON.parse(readFileSync(join(cwd, 'My Film', 'package.json'), 'utf8')).name,
    'my-film',
  )
})

test('an unknown flag prints one line pointing to --help and exits 2', () => {
  const { status, stdout, stderr } = bin('--nope')
  assert.equal(status, 2)
  assert.equal(stdout, '')
  assert.deepEqual(stderr.trimEnd().split('\n'), [
    'Unknown option: --nope. See create-shaderera --help.',
  ])
})
