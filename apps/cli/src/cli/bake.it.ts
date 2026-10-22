import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { decode } from 'fast-png'
import { cli as run } from '../fixtures/cli.ts'
import { tempDir } from '../fixtures/temp.ts'

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0

/**
 * The fixture's bake writes one byte a frame (level.txt + the frame number) into `../glow`, a
 * folder outside the project; the source paints the byte as a grey.
 */
test('a bake is made and stamped, read by the host, and refused when stale or changed', async () => {
  const root = join(tempDir('bake'), 'film')
  cpSync(fileURLToPath(new URL('./fixtures/bake/', import.meta.url)), root, { recursive: true })
  const glow = join(root, '..', 'glow')
  const out = join(root, 'out', 'stills')
  const cli = (...args: string[]) => run(...args, '--root', root)
  const grey = async (t: string, ...flags: string[]) => {
    const r = await cli('still', t, '--out', out, ...flags)
    assert.equal(r.status, 0, r.stderr)
    return decode(readFileSync(join(out, `main-${Number(t).toFixed(3)}.png`))).data[0]
  }
  // Every command that opens the source refuses it alike: all three once, then one each.
  const all = [['check', '--times', '2'], ['still', '0'], ['render']]
  const refused = async (pattern: RegExp, commands = all) => {
    for (const command of commands) {
      const r = await cli(...command)
      assert.equal(r.status, 2, `${command[0]}: ${r.stderr}`)
      assert.match(r.stderr, pattern, command[0])
    }
  }

  await refused(/Bake glow has not been made: shaderera bake glow\./)
  const made = await cli('bake')
  assert.equal(made.status, 0, made.stderr)
  assert.match(made.stdout, /^glow: 10 frames, .* stamped$/m)
  const stamp = JSON.parse(readFileSync(join(root, 'versions', 'bakes', 'glow.json'), 'utf8'))
  assert.equal(stamp.frames.length, 10)
  assert.deepEqual(Object.keys(stamp.inputs.files), ['level.txt', 'tools/make.mjs'])

  // Read through the host, from outside the project; in the browser host too.
  assert.equal(await grey('0.5'), 45)
  assert.equal(await grey('0.3', '--host', 'browser'), 43)
  if (ffmpeg) assert.equal((await cli('render', '--out', join(root, 'out', 'f.mp4'))).status, 0)
  // The bake's folder is read only through io.bake: io.read still refuses it.
  const peek = await cli('inspect', '0', '--param', `peek=${join(glow, 'glow.000.bin')}`, '--json')
  assert.match(JSON.parse(peek.stdout).result.peek, /outside the project/)

  writeFileSync(join(root, 'level.txt'), '90')
  await refused(
    /Bake glow is stale: level\.txt changed since it was made\. Run shaderera bake glow\./,
    [['check', '--times', '2']],
  )
  assert.equal((await cli('bake', 'glow')).status, 0)
  assert.equal(await grey('0.5'), 95)

  writeFileSync(join(glow, 'glow.003.bin'), new Uint8Array([1]))
  await refused(/Bake glow: glow\.003\.bin changed since it was made\. Run shaderera bake glow\./, [
    ['still', '0'],
  ])
  rmSync(join(glow, 'glow.003.bin'))
  await refused(/Bake glow: glow\.003\.bin is missing from .*glow\. Run shaderera bake glow\./, [
    ['render'],
  ])
  assert.equal((await cli('bake')).status, 0)
  assert.ok(existsSync(join(glow, 'glow.003.bin')))
})

test('a bake whose command fails, or names another bake, stamps nothing', async () => {
  const root = join(tempDir('bake'), 'film')
  cpSync(fileURLToPath(new URL('./fixtures/bake/', import.meta.url)), root, { recursive: true })
  writeFileSync(join(root, 'tools', 'make.mjs'), 'process.exit(3)\n')
  const cli = (...args: string[]) => run(...args, '--root', root)
  assert.match(
    (await cli('bake')).stderr,
    /bake glow: node tools\/make\.mjs exited with 3; nothing was stamped/,
  )
  assert.equal(existsSync(join(root, 'versions', 'bakes', 'glow.json')), false)
  assert.match((await cli('bake', 'snow')).stderr, /declares no bake "snow" \(it declares glow\)/)
})

test('a job pins the bakes its source reads; render --job refuses one that no longer matches', {
  skip: !ffmpeg && 'no ffmpeg',
}, async () => {
  const root = join(tempDir('bake-job'), 'film')
  cpSync(fileURLToPath(new URL('./fixtures/bake/', import.meta.url)), root, { recursive: true })
  const cli = (...args: string[]) => run(...args, '--root', root)
  assert.equal((await cli('bake')).status, 0)
  const made = await cli('job', '--name', 'final')
  assert.equal(made.status, 0, made.stderr)
  const job = JSON.parse(readFileSync(join(root, 'versions', 'jobs', 'final.json'), 'utf8'))
  const stamp = JSON.parse(readFileSync(join(root, 'versions', 'bakes', 'glow.json'), 'utf8'))
  assert.deepEqual(job.inputs.bakes.glow, {
    inputs: stamp.inputs.hash,
    dir: join(root, '..', 'glow'),
    pattern: 'glow.###.bin',
    frames: stamp.frames,
  })
  const rendered = await cli('render', '--job', 'final')
  assert.equal(rendered.status, 0, rendered.stderr)

  const handoff = await cli('handoff', 'final')
  assert.equal(handoff.status, 0, handoff.stderr)
  const reproduce = readFileSync(join(root, 'out', 'handoff', 'final', 'REPRODUCE.md'), 'utf8')
  assert.match(
    reproduce,
    /## Bakes[\s\S]*- `glow`: 10 frames in `.*glow`, made by `node tools\/make\.mjs`/,
  )

  // Baked again from other inputs: the working tree renders, the job does not.
  writeFileSync(join(root, 'level.txt'), '70')
  assert.equal((await cli('bake')).status, 0)
  const refused = await cli('render', '--job', 'final')
  assert.equal(refused.status, 2, refused.stderr)
  assert.match(
    refused.stderr,
    /Bake glow no longer matches job final: glow\.000\.bin changed since it was made\. Bake it again from the job's revision \(shaderera restore \w+, then shaderera bake glow\), or make a new job\./,
  )
  // A job of a revision the stamp was not made from is refused when it is made.
  writeFileSync(join(root, 'level.txt'), '71')
  assert.match(
    (await cli('job', '--name', 'other')).stderr,
    /Bake glow was made from other inputs than revision \w+ has/,
  )
})

test('a bake stamps only what this run wrote, follows the project when it moves, and keeps out of revisions', async () => {
  const base = tempDir('bake')
  const root = join(base, 'film')
  cpSync(fileURLToPath(new URL('./fixtures/bake/', import.meta.url)), root, { recursive: true })
  const cli = (at: string, ...args: string[]) => run(...args, '--root', at)
  const manifest = join(root, 'shaderera.json')
  const declare = (change: (bake: { [key: string]: unknown }) => void) => {
    const m = JSON.parse(readFileSync(manifest, 'utf8'))
    change(m.bakes.glow)
    writeFileSync(manifest, JSON.stringify(m))
  }

  // Inputs as a revision lists them: `.` leaves out node_modules, out/ and the stamp itself.
  declare((b) => {
    b.inputs = ['.']
  })
  cpSync(join(root, 'tools'), join(root, 'node_modules', 'x'), { recursive: true })
  assert.equal((await cli(root, 'bake')).status, 0)
  writeFileSync(join(root, 'node_modules', 'x', 'make.mjs'), '// changed')
  assert.equal((await cli(root, 'check', '--times', '2')).status, 0)
  // A job lists the inputs from its revision by the same rules, so the stamp matches it.
  const job = await cli(root, 'job', '--name', 'dot')
  assert.equal(job.status, 0, job.stderr)

  // A frame left from an earlier, longer run is removed, never stamped as fresh.
  writeFileSync(join(base, 'glow', 'glow.010.bin'), new Uint8Array([1]))
  assert.equal((await cli(root, 'bake')).status, 0)
  assert.equal(existsSync(join(base, 'glow', 'glow.010.bin')), false)

  // Moved with its frames: the declared dir is read where the project is now.
  const moved = join(tempDir('moved'), 'film')
  cpSync(base, join(moved, '..'), { recursive: true })
  rmSync(join(base, 'glow'), { recursive: true })
  assert.equal((await cli(moved, 'check', '--times', '2')).status, 0)

  // In the project, a bake's folder goes under out/.
  declare((b) => {
    b.dir = 'frames'
  })
  assert.match((await cli(root, 'bake')).stderr, /A bake's dir in the project goes under out\//)
})
