import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { findPackageJSON } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { shareFiles } from '../cli/share.ts'
import { tempDir } from '../fixtures/temp.ts'
import { findProject } from '../node/project.ts'
import { probeVideo } from '../node/services.ts'
import { buildPlayer } from './build.ts'
import { ffmpeg, footageProject } from './fixtures/make.ts'

const temp = (name: string) => tempDir(`player-${name}`)

/** A copy of the CLI's camera fixture: a canvas film, no media, `stamp` set or not. */
const plainProject = async (stamp: boolean) => {
  const root = temp('plain')
  cpSync(fileURLToPath(new URL('../cli/fixtures/mcp/', import.meta.url)), root, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(root, 'shaderera.json'), 'utf8'))
  if (!stamp) delete manifest.stamp
  writeFileSync(join(root, 'shaderera.json'), JSON.stringify(manifest))
  return findProject(root)
}

const build = async (project: Awaited<ReturnType<typeof findProject>>, parents?: string[]) => {
  const outDir = join(project.root, '.shaderera', 'player')
  const player = await buildPlayer(project, {
    outDir,
    files: Object.keys(shareFiles(project.root).files),
    ...(parents ? { parents } : {}),
  })
  const code = player.files
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(join(outDir, f), 'utf8'))
    .join('\n')
  return { outDir, player, code }
}

test('a player is static: a page, the runner, the film bundled and its files', async () => {
  const project = await plainProject(true)
  const { outDir, player, code } = await build(project)
  for (const f of ['runner.html', 'assets/bridge.js', 'assets/worker.js', 'files/shaderera.json'])
    assert.ok(player.files.includes(f), `${f} missing from ${player.files.join()}`)
  assert.deepEqual(
    player.files.filter((f) => f.startsWith('files/')).map((f) => f.slice(6)),
    Object.keys(shareFiles(project.root).files).sort(),
    "the film's files as a share sends them",
  )
  assert.ok(!player.files.some((f) => /^(media|bakes)\//.test(f)))
  assert.ok(player.bytes > 0)
  // The parents: shaderera.com unless the build names others.
  assert.match(
    readFileSync(join(outDir, 'runner.html'), 'utf8'),
    /<meta name="shaderera-parents" content="https:\/\/shaderera\.com">/,
  )
  // The film is bundled, not fetched from a runner server, and the CLI's service token is a module
  // that throws: nothing in a player can ask the CLI's process.
  assert.doesNotMatch(code, /\/__shaderera\/(entry|dom)\.js/)
  assert.match(code, /A web player has no CLI process behind it/)
  // The worker starts from a data: URL, so a frame sandboxed with allow-scripts alone can start it.
  assert.match(readFileSync(join(outDir, 'assets/bridge.js'), 'utf8'), /`data:text\/javascript,/)
  // Nothing in the build names the folder it was built in.
  assert.doesNotMatch(code, /^\/\/#region/m)
  assert.ok(!code.includes(project.root.replaceAll('\\', '/')))

  const other = await build(project, ['https://a.example', 'http://127.0.0.1:8787'])
  assert.match(
    readFileSync(join(other.outDir, 'runner.html'), 'utf8'),
    /content="https:\/\/a\.example http:\/\/127\.0\.0\.1:8787"/,
  )
  await assert.rejects(build(project, ['https://a.example/page']), /Not an origin/)
  await assert.rejects(build(project, []), /at least one parent/)
})

test('a build error leaves as plain text, without colour codes', async () => {
  const project = await plainProject(false)
  writeFileSync(join(project.root, 'src', 'composition.ts'), 'export default (t =>\n')
  await assert.rejects(build(project), (e: Error) => {
    assert.match(e.message, /composition\.ts/)
    assert.equal(e.message.includes('\x1b'), false)
    return true
  })
})

test('the stamp runs when shaderera.json sets it, and only then', async () => {
  const stamped = await build(await plainProject(true))
  assert.match(stamped.code, /source: "src\/composition\.ts:\d+:\d+",\s*id: "camera"/)
  const plain = await build(await plainProject(false))
  assert.match(plain.code, /id: "camera"/)
  assert.doesNotMatch(plain.code, /source: "src\/composition\.ts/)
  // Two different films, one worker: a site keeps it once.
  const worker = (b: { outDir: string }) => readFileSync(join(b.outDir, 'assets/worker.js'))
  assert.ok(worker(stamped).equals(worker(plain)))
})

test('a player carries the licence notices of every package it bundles, the same bytes each build', async () => {
  const notices = (b: { outDir: string }) =>
    readFileSync(join(b.outDir, 'assets/THIRD-PARTY-NOTICES.txt'))
  const project = await plainProject(true)
  const first = await build(project)
  const bytes = notices(first)
  const text = bytes.toString('utf8')
  const root = (name: string, from = import.meta.url) => {
    const pkg = findPackageJSON(name, from)
    assert.ok(pkg, `${name} installed`)
    return realpathSync(dirname(pkg))
  }
  const fastPng = pathToFileURL(join(root('fast-png'), 'package.json')).href
  const bundled: [string, string, string][] = [
    ['comlink', root('comlink'), 'Apache-2.0'],
    ['fast-png', root('fast-png'), 'MIT'],
    ['fflate', root('fflate', fastPng), 'MIT'],
    ['iobuffer', root('iobuffer', fastPng), 'MIT'],
    ['jpeg-js', root('jpeg-js'), 'BSD-3-Clause'],
    ['mediabunny', root('mediabunny'), 'MPL-2.0'],
  ]
  for (const [name, dir, license] of bundled) {
    const { version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    assert.ok(text.includes(`\n- ${name} ${version} (${license})\n`), `${name} listed`)
    assert.ok(text.includes(`\n${name} ${version}\nLicense: ${license}\n`), `${name}'s section`)
    const licence = readFileSync(join(dir, 'LICENSE'), 'utf8').replace(/\r\n/g, '\n').trimEnd()
    assert.ok(text.includes(licence), `${name}'s LICENSE text`)
  }
  // The licence headers the bundler drops from the code: jpeg-js's encoder is Adobe's.
  assert.match(text, /Copyright \(c\) 2008, Adobe Systems Incorporated/)
  // The engine's own packages too; the film's own code is the author's.
  assert.match(text, /\n- @shaderera\/core \S+ \(MIT\)\n/)
  assert.match(text, /\n- shaderera \S+ \(MIT\)\n/)
  assert.ok(!text.includes(project.root.replaceAll('\\', '/')) && !text.includes(project.root))
  // A reader of the served player finds it from the page.
  assert.match(
    readFileSync(join(first.outDir, 'runner.html'), 'utf8'),
    /assets\/THIRD-PARTY-NOTICES\.txt/,
  )
  // Deterministic: built again, or from another folder, it is the same file.
  const again = notices(await build(project))
  assert.ok(again.equals(bytes), 'the same bytes built again')
  const elsewhere = notices(await build(await plainProject(true)))
  assert.ok(elsewhere.equals(bytes), 'the same bytes built in another folder')
})

test('footage gets a proxy with the original frames: H.264, yuv420p, no B-frames, a keyframe every 15', {
  skip: !ffmpeg && 'needs ffmpeg',
}, async () => {
  const project = await footageProject()
  const { outDir, player } = await build(project)
  for (const f of [
    'files/assets/clip.mp4',
    'media/assets/clip.mp4.mp4',
    'media/assets/clip.mp4.json',
  ])
    assert.ok(player.files.includes(f), `${f} missing`)
  const info = { width: 320, height: 180, fps: 30, frames: 30 }
  assert.deepEqual(
    JSON.parse(readFileSync(join(outDir, 'media/assets/clip.mp4.json'), 'utf8')),
    info,
  )
  const proxy = join(outDir, 'media/assets/clip.mp4.mp4')
  assert.deepEqual(probeVideo(proxy), info)
  const r = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,pix_fmt,color_space:frame=pict_type,key_frame',
      '-of',
      'json',
      proxy,
    ],
    { encoding: 'utf8' },
  )
  const probed = JSON.parse(r.stdout) as {
    streams: { codec_name: string; pix_fmt: string; color_space: string }[]
    frames: { pict_type: string; key_frame: number }[]
  }
  assert.deepEqual(probed.streams[0], {
    codec_name: 'h264',
    pix_fmt: 'yuv420p',
    color_space: 'bt709',
  })
  assert.equal(probed.frames.length, 30)
  assert.ok(!probed.frames.some((f) => f.pict_type === 'B'), 'no B-frames')
  assert.deepEqual(
    probed.frames.flatMap((f, i) => (f.key_frame ? [i] : [])),
    [0, 15],
  )
  // Its bake, as its stamp lists the frames.
  assert.deepEqual(JSON.parse(readFileSync(join(outDir, 'bakes/level.json'), 'utf8')), {
    frames: ['level.0.bin', 'level.1.bin', 'level.2.bin'],
  })
  assert.deepEqual([...readFileSync(join(outDir, 'bakes/level/level.2.bin'))], [102])
})

test('a bake that is stale or changed stops the build, and leaves no player behind', {
  skip: !ffmpeg && 'needs ffmpeg',
}, async () => {
  const project = await footageProject()
  const { outDir } = await build(project)
  writeFileSync(join(project.root, 'out/level/level.1.bin'), new Uint8Array([9]))
  await assert.rejects(
    build(project),
    /Bake level: level\.1\.bin changed since it was made\. Run shaderera bake level\./,
  )
  assert.ok(!existsSync(outDir), 'the earlier player is gone too')
  writeFileSync(join(project.root, 'tools/make.mjs'), '// changed\n')
  await assert.rejects(build(project), /Bake level is stale: tools\/make\.mjs changed/)
})
