import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { shadereraVersion } from '../deliver/environment.ts'
import { type AdapterInfo, adapterLine, softwareAdapter } from '../node/adapter.ts'
import { browserAdapter, chromePath } from '../node/browser.ts'
import { hostOf } from '../node/host-of.ts'
import { findProject } from '../node/project.ts'
import { hardwareEncoder } from './ffmpeg.ts'
import { EXIT, found } from './findings.ts'
import { dayOf } from './login.ts'
import { licenceOf } from './share.ts'
import { apiOf, readToken, signInHint } from './site.ts'
import { whoIs } from './whoami.ts'

/** One thing the machine or the project has, or lacks. `missing` on a needed item fails doctor. */
export type DoctorItem = {
  id: string
  status: 'ok' | 'missing' | 'warn'
  detail: string
  /** What a render, a still or a delivery cannot do without it. */
  needed: boolean
  fix?: string
  /** The `gpu` item: the adapter's limits a film runs into, as the Node host's device gets them. */
  limits?: { [name: string]: number }
}

/**
 * The limits films run into: one buffer's size, one storage binding's, a 2D texture's side and an
 * array's layers. The Node host asks for each at the adapter's maximum (fullDevice), so the
 * adapter's are the device's.
 */
export const LIMITS = [
  'maxBufferSize',
  'maxStorageBufferBindingSize',
  'maxTextureDimension2D',
  'maxTextureArrayLayers',
] as const

const mb = (bytes = 0) => `${(bytes / 2 ** 20).toFixed(0)} MB`

/** The limits in one line: `buffers to 2048 MB, storage binding 2048 MB, textures to 16384 px, 2048 layers`. */
export const limitsLine = (l: { [name: string]: number }) =>
  `buffers to ${mb(l.maxBufferSize)}, storage binding ${mb(l.maxStorageBufferBindingSize)}, textures to ${l.maxTextureDimension2D} px, ${l.maxTextureArrayLayers} layers`

const firstLine = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 20_000 })
  return r.status === 0 ? (r.stdout.trim().split(/\r?\n/)[0] ?? '') : undefined
}

/** The ffmpeg encoders and filters a delivery uses, as this ffmpeg lists them. */
const FFMPEG_PARTS = [
  ['libx264', 'encoders', 'H.264 (every mp4)', true],
  ['aac', 'encoders', 'AAC (mp4 audio)', true],
  ['prores_ks', 'encoders', 'ProRes (--format prores-*)', false],
  ['pcm_s24le', 'encoders', '24-bit PCM (WAV, mov)', false],
  ['ebur128', 'filters', 'loudness (EBU R128)', false],
  ['amultiply', 'filters', 'gain functions', false],
] as const

/** Dawn in the project, asked in a child process: its version, adapter, features and limits. */
const probeGpu = (root: string) => {
  const script = `
    import { createRequire } from 'node:module'
    const require = createRequire(${JSON.stringify(join(root, 'package.json'))})
    const dawn = require('webgpu')
    const version = require(require.resolve('webgpu/package.json')).version
    Object.assign(globalThis, dawn.globals)
    const gpu = dawn.create([])
    const adapter = await gpu.requestAdapter()
    const info = adapter?.info
    process.stdout.write(JSON.stringify({
      version,
      info: info ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description, isFallbackAdapter: info.isFallbackAdapter } : null,
      features: adapter ? [...adapter.features].sort() : [],
      limits: adapter ? Object.fromEntries(${JSON.stringify(LIMITS)}.map((k) => [k, adapter.limits[k]])) : {},
    }))
    process.exit(0)`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  })
  try {
    return JSON.parse(r.stdout) as {
      version: string
      info: AdapterInfo | null
      features: string[]
      limits: { [name: string]: number }
    }
  } catch {
    return { error: (r.stderr || r.stdout || 'no output').trim().split(/\r?\n/)[0] as string }
  }
}

/** What to check when a host's adapter is software. */
const SOFTWARE_FIX = {
  node: 'Renders refuse it without --software-gpu. Check that the GPU driver is installed and, in a container, passed through (--gpus all, /dev/dri), and on Linux that a Vulkan ICD for the GPU is installed (vulkaninfo --summary lists it).',
  browser:
    'Renders refuse it without --software-gpu. Check that the GPU driver is installed and, in a container, passed through (--gpus all, /dev/dri), and that nothing turns off Chrome’s GPU (--disable-gpu, a blocklisted driver: chrome://gpu in a windowed Chrome says).',
}

/**
 * The `gpu` item from the host's adapter (null: none): `warn` on a software renderer
 * (softwareAdapter), which a render refuses without `--software-gpu`. The Node host's carries
 * Dawn's features and limits.
 */
export const gpuItem = (
  host: 'node' | 'browser',
  info: AdapterInfo | null,
  dawn?: { features: string[]; limits: { [name: string]: number } },
): DoctorItem => {
  if (!info)
    return {
      id: 'gpu',
      status: 'missing',
      detail: host === 'node' ? 'Dawn found no GPU adapter' : 'Chrome’s WebGPU found no adapter',
      needed: true,
    }
  const software = softwareAdapter(info)
  const detail = `${adapterLine(info)}${dawn ? `; ${dawn.features.length} features (${dawn.features.join(', ')}); ${limitsLine(dawn.limits)}` : ` (${host} host)`}`
  return {
    id: 'gpu',
    status: software ? 'warn' : 'ok',
    detail: software ? `software, ${software}: ${detail}` : detail,
    needed: true,
    ...(software ? { fix: SOFTWARE_FIX[host] } : {}),
    ...(dawn ? { limits: dawn.limits } : {}),
  }
}

/** Everything doctor checks, for the machine and (inside one) the project. */
export const doctor = async (cwd: string): Promise<DoctorItem[]> => {
  const items: DoctorItem[] = []
  const major = Number(process.versions.node.split('.')[0])
  items.push({
    id: 'node',
    status: major >= 24 ? 'ok' : 'missing',
    detail: process.version,
    needed: true,
    ...(major >= 24 ? {} : { fix: 'Install Node 24 or later.' }),
  })
  items.push({ id: 'shaderera', status: 'ok', detail: shadereraVersion(), needed: true })
  const ffmpeg = firstLine('ffmpeg', ['-version'])
  items.push({
    id: 'ffmpeg',
    status: ffmpeg ? 'ok' : 'missing',
    detail: ffmpeg ?? 'not on the PATH',
    needed: true,
    ...(ffmpeg ? {} : { fix: 'Install ffmpeg from https://ffmpeg.org/download.html' }),
  })
  const ffprobe = firstLine('ffprobe', ['-version'])
  items.push({
    id: 'ffprobe',
    status: ffprobe ? 'ok' : 'missing',
    detail: ffprobe ?? 'not on the PATH',
    needed: true,
    ...(ffprobe ? {} : { fix: 'ffprobe comes with ffmpeg: put its folder on the PATH.' }),
  })
  if (ffmpeg) {
    const lists = {
      encoders: spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout,
      filters: spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout,
    }
    for (const [name, list, what, needed] of FFMPEG_PARTS) {
      const has = new RegExp(`\\s${name}\\s`).test(lists[list])
      items.push({
        id: `ffmpeg:${name}`,
        status: has ? 'ok' : needed ? 'missing' : 'warn',
        detail: `${what}${has ? '' : ': not in this ffmpeg'}`,
        needed,
        ...(has
          ? {}
          : { fix: 'Use a full ffmpeg build (gyan.dev "full", or your package manager’s).' }),
      })
    }
    const gpu = await hardwareEncoder(1920, 1080, { fresh: true })
    items.push({
      id: 'ffmpeg:h264-gpu',
      status: gpu ? 'ok' : 'warn',
      detail: gpu
        ? `${gpu}: H.264 on the GPU, at 1920×1080 (review renders use it)`
        : 'not usable here: review renders use x264',
      needed: false,
    })
  }
  const chrome = chromePath()
  let project: Awaited<ReturnType<typeof findProject>> | undefined
  try {
    project = await findProject(cwd)
  } catch (e) {
    // Not inside a project: the machine only. Or a project that requires a plugin it lacks.
    const [head, ...lines] = ((e as Error).message ?? '').split('\n')
    if (head?.startsWith('This project needs'))
      items.push({
        id: 'requires',
        status: 'missing',
        detail: lines
          .filter((l) => l.startsWith('  - '))
          .map((l) => l.slice(4))
          .join('; '),
        needed: true,
        fix: lines
          .filter((l) => l.startsWith('  npx'))
          .map((l) => l.trim())
          .join(' | '),
      })
  }
  const browser = project ? hostOf(project.manifest, undefined) === 'browser' : false
  items.push({
    id: 'chrome',
    status: chrome ? 'ok' : browser ? 'missing' : 'warn',
    detail: chrome
      ? `${chrome}${process.env.CHROME ? ' (CHROME)' : ''}`
      : 'not found: the browser host cannot run',
    needed: browser,
    ...(chrome ? {} : { fix: 'Install Google Chrome, or set CHROME to its executable.' }),
  })
  let api: string | undefined
  try {
    api = apiOf()
  } catch (e) {
    items.push({ id: 'sign-in', status: 'warn', detail: (e as Error).message, needed: false })
  }
  if (api) items.push(await signInItem(api))
  if (!project) return items
  items.push({
    id: 'project',
    status: 'ok',
    detail: `${project.root} (${project.manifest.width}×${project.manifest.height}, ${project.manifest.fps} fps, ${project.manifest.duration} s, ${browser ? 'browser' : 'node'} host)`,
    needed: true,
  })
  items.push(shareItem(project.root))
  let webgpu = false
  try {
    createRequire(join(project.root, 'package.json')).resolve('webgpu')
    webgpu = true
  } catch {
    // No Dawn in this project.
  }
  if (!browser && !webgpu)
    items.push({
      id: 'webgpu',
      status: 'warn',
      detail: 'not installed: the Node host gives the source no GPU and composites on the CPU',
      needed: false,
      fix: 'npm install webgpu (in the project)',
    })
  if (!browser && webgpu) {
    const gpu = probeGpu(project.root)
    if ('error' in gpu)
      items.push({ id: 'webgpu', status: 'missing', detail: gpu.error, needed: true })
    else {
      items.push({
        id: 'webgpu',
        status: 'ok',
        detail: `webgpu ${gpu.version} (Dawn)`,
        needed: true,
      })
      items.push(gpuItem('node', gpu.info, gpu))
    }
    // Two Dawns in one process crash it (decision 0011, G2): more than one webgpu installed.
    const copies = webgpuCopies(project.root)
    if (copies.length > 1)
      items.push({
        id: 'webgpu:copies',
        status: 'warn',
        detail: `${copies.length} copies installed (${copies.join(', ')}): a library that loads its own Dawn crashes the host`,
        needed: false,
        fix: 'Give the library host.gpu (vgpu: initFromDevice) and dedupe webgpu to one version.',
      })
  }
  if (browser && chrome) {
    try {
      items.push(gpuItem('browser', await browserAdapter(chrome)))
    } catch (e) {
      items.push({
        id: 'gpu',
        status: 'warn',
        detail: `Chrome’s WebGPU could not be asked: ${(e as Error).message}`,
        needed: false,
      })
    }
  }
  const fonts = join(project.root, 'fonts')
  if (existsSync(fonts))
    items.push({
      id: 'fonts',
      status: 'ok',
      detail: 'fonts/ (registered by the source with io.font)',
      needed: false,
    })
  return items
}

/**
 * Whether this machine is signed in to the films API (`SHADERERA_API`, else api.shaderera.com),
 * and as whom: `GET /api/v1/auth/me`, given 5 s. Never needed: only `share` signs in.
 */
export const signInItem = async (api: string): Promise<DoctorItem> => {
  const base = { id: 'sign-in', needed: false }
  if (!readToken(api))
    return { ...base, status: 'warn', detail: `not signed in to ${api}`, fix: signInHint(api) }
  try {
    const me = await Promise.race([
      whoIs(api),
      new Promise<never>((_, no) =>
        setTimeout(() => no(new Error('no answer in 5 s')), 5000).unref(),
      ),
    ])
    if (me)
      return {
        ...base,
        status: 'ok',
        detail: `${me.handle} on ${api} (this machine as "${me.name}", until ${dayOf(me.expiresAt)})`,
      }
  } catch (e) {
    const message = (e as Error).message
    if (/: 401 /.test(message))
      return {
        ...base,
        status: 'warn',
        detail: `the token here is no longer signed in to ${api}`,
        fix: signInHint(api),
      }
    return { ...base, status: 'warn', detail: `a token for ${api}, not checked: ${message}` }
  }
  return { ...base, status: 'warn', detail: `not signed in to ${api}`, fix: signInHint(api) }
}

/** Whether the project can be shared: it declares a licence (package.json's `license`). */
export const shareItem = (root: string): DoctorItem => {
  try {
    return { id: 'share', status: 'ok', detail: `licence ${licenceOf(root)}`, needed: false }
  } catch {
    return {
      id: 'share',
      status: 'warn',
      detail: 'no licence: share refuses the project',
      needed: false,
      fix: 'Set "license" in package.json (an SPDX id such as MIT, or UNLICENSED for all rights reserved).',
    }
  }
}

/**
 * Every `webgpu` package installed in the project, as `version (path)`: nested node_modules
 * (npm, yarn) and pnpm's store folders (`.pnpm/webgpu@x`).
 */
export const webgpuCopies = (root: string): string[] => {
  const found = new Map<string, string>()
  const add = (dir: string) => {
    const pkg = join(dir, 'package.json')
    if (existsSync(pkg)) found.set(dir, JSON.parse(readFileSync(pkg, 'utf8')).version)
  }
  const list = (dir: string) => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  }
  const visit = (modules: string, depth: number) => {
    if (depth > 4 || !existsSync(modules)) return
    add(join(modules, 'webgpu'))
    for (const name of list(modules)) {
      if (name === '.pnpm') {
        for (const entry of list(join(modules, name)))
          if (entry.startsWith('webgpu@')) add(join(modules, name, entry, 'node_modules', 'webgpu'))
      } else if (name.startsWith('@')) {
        for (const sub of list(join(modules, name)))
          visit(join(modules, name, sub, 'node_modules'), depth + 1)
      } else if (name !== 'webgpu' && name !== '.bin')
        visit(join(modules, name, 'node_modules'), depth + 1)
    }
  }
  visit(join(root, 'node_modules'), 0)
  // pnpm links node_modules/webgpu into its store: count each version once.
  const byVersion = new Map<string, string>()
  for (const [dir, version] of found) if (!byVersion.has(version)) byVersion.set(version, dir)
  return [...byVersion].map(([version, dir]) => `${version} (${dir})`)
}

/** `shaderera doctor [--json]`: what this machine and project have, and what they lack. */
export const run = async (argv: readonly string[]): Promise<number> => {
  const json = argv.includes('--json')
  const items = await doctor(process.cwd())
  const failed = items.some((i) => i.needed && i.status === 'missing')
  for (const i of items)
    if (i.status !== 'ok')
      found({
        code: `doctor:${i.id}`,
        severity: i.needed && i.status === 'missing' ? 'error' : 'warning',
        message: `${i.detail}${i.fix ? `. ${i.fix}` : ''}`,
      })
  if (json) console.log(JSON.stringify({ ok: !failed, items }, null, 2))
  else
    for (const i of items)
      console.log(
        `${{ ok: '✓', missing: '✗', warn: '!' }[i.status]} ${i.id.padEnd(18)} ${i.detail}${i.fix ? `\n  ${''.padEnd(18)} ${i.fix}` : ''}`,
      )
  return failed ? EXIT.failed : EXIT.ok
}
