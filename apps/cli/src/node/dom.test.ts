import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createJob, openJob } from '../project/jobs.ts'
import { review } from '../review/review.ts'
import { openBrowserChild } from './browser.ts'
import { findProject } from './project.ts'

/**
 * DOM capture in the browser host fails rather than accepting a frame it could not trust. Needs
 * Chrome (CHROME overrides); without it these fail, they do not skip.
 */
const project = await findProject(join(import.meta.dirname, 'fixtures', 'dom'))
const opened = (mode: string) => openBrowserChild(project, { params: { mode } })

test('a DOM that settles is captured, and the same t gives the same pixels', async () => {
  const child = await opened('still')
  try {
    const a = await child.render(0.3, 'final')
    await child.render(0.7, 'final')
    const b = await child.render(0.3, 'final')
    assert.deepEqual(a.pixels, b.pixels)
    // Drawn, not blank: the fixture's white background covers every pixel.
    const opaque = a.pixels.filter((_, i) => i % 4 === 3 && a.pixels[i] === 255).length
    assert.equal(opaque, 64 * 32)
    const identity = await child.identity()
    assert.equal(identity.host, 'browser')
    assert.match(identity.browser ?? '', /Chrome\/\d+/)
    assert.ok(identity.flags?.includes('--enable-features=CanvasDrawElement'))
  } finally {
    await child.close()
  }
})

for (const [mode, message] of [
  ['clock', /did not settle/],
  ['image', /image .*missing\.png did not load/],
  ['font', /font "Broken" failed to load/],
] as const) {
  test(`a DOM with ${mode === 'clock' ? 'its own clock' : `a missing ${mode}`} fails the capture`, async () => {
    // The page draws the DOM once while it opens, so the failure may come from open or render.
    await assert.rejects(async () => {
      const child = await opened(mode)
      try {
        await child.render(0.3, 'final')
      } finally {
        await child.close()
      }
    }, message)
  })
}

test('a hung source fails the call after timeoutMs and closes Chrome', async () => {
  const child = await openBrowserChild(project, { params: { mode: 'hang' }, timeoutMs: 3000 })
  try {
    await assert.rejects(child.render(0.3, 'final'), /took longer than 3000 ms/)
    await assert.rejects(child.render(0.3, 'final'), /Chrome closed/)
  } finally {
    await child.close()
  }
})

test("a job opens in the manifest's host with its revision's own DOM, not the live one", async () => {
  const root = join(mkdtempSync(join(tmpdir(), 'shaderera-dom-job-')), 'film')
  cpSync(project.root, root, { recursive: true, filter: (p) => !p.includes('.shaderera') })
  const job = await createJob(root, { by: 'cli', name: 'dom' })
  assert.equal(job.host, 'browser')
  const dom = join(root, 'src', 'dom.ts')
  writeFileSync(dom, readFileSync(dom, 'utf8').replace('background:#fff', 'background:#000'))
  /** The bottom-right pixel, clear of the text. */
  const corner = async (
    o: Promise<{
      render: (t: number, i: 'final') => Promise<{ pixels: Uint8Array }>
      close: () => Promise<void>
    }>,
  ) => {
    const child = await o
    try {
      const { pixels } = await child.render(0.3, 'final')
      return [...pixels.subarray(pixels.length - 4)]
    } finally {
      await child.close()
    }
  }
  assert.deepEqual(await corner(openJob(root, job).then((o) => o.child)), [255, 255, 255, 255])
  const live = await findProject(root)
  assert.deepEqual(await corner(openBrowserChild(live)), [0, 0, 0, 255])
  // The size a review reopens with reaches the page.
  const small = await openBrowserChild(live, { size: { width: 32, height: 16 } })
  try {
    assert.equal((await small.render(0.3, 'final')).pixels.length, 32 * 16 * 4)
  } finally {
    await small.close()
  }
})

test('the host measures the DOM text: boxes, opacity, and the fonts that drew it (fallbacks named)', async () => {
  const child = await opened('type')
  try {
    const runs = await child.text(0.3)
    const by = Object.fromEntries(runs.map((r) => [r.id, r]))
    assert.equal(by.latin?.text, 'Open')
    assert.equal(by.mixed?.text, 'Open เปิด')
    assert.equal(by.mixed?.opacity, 0.5)
    assert.equal(by.latin?.size, 20)
    const [x, y, w, h] = by.latin?.box ?? []
    assert.ok(x === 0 && (y ?? -1) >= 0 && (w ?? 0) > 20 && (h ?? 0) > 15, String(by.latin?.box))
    // Latin text: only the web font. Thai: a system font the run did not name.
    assert.deepEqual(
      by.latin?.rendered?.map((f) => f.custom),
      [true],
    )
    assert.ok(
      by.mixed?.rendered?.some((f) => !f.custom && f.glyphs > 0),
      JSON.stringify(by.mixed),
    )
  } finally {
    await child.close()
  }
})

test('review checks DOM text without the source reporting it: copy found, a fallback font fails glyphs', async () => {
  const child = await opened('type')
  try {
    const r = await review({
      project,
      child,
      outDir: mkdtempSync(join(tmpdir(), 'shaderera-dom-review-')),
      requirements: { version: 1, copy: [{ text: 'Open เปิด' }] },
      quick: true,
    })
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c]))
    assert.equal(by.copy?.status, 'pass', JSON.stringify(by.copy))
    assert.equal(by.glyphs?.status, 'fail')
    assert.match(
      by.glyphs?.detail ?? '',
      /mixed: drawn partly in .+, which its font-family does not name/,
    )
    assert.doesNotMatch(by.glyphs?.detail ?? '', /latin:/)
  } finally {
    await child.close()
  }
})

test('domScale draws the DOM with more pixels at the same layout; as a layer it fills the frame', async () => {
  const scaled = await findProject(join(import.meta.dirname, 'fixtures', 'dom-scale'))
  const child = await openBrowserChild(scaled)
  try {
    const frame = await child.render(0.3, 'final')
    assert.equal(frame.pixels.length, 64 * 32 * 4)
    const seen = (await child.inspect(0.3)) as { width: number; height: number; row: number[] }
    assert.deepEqual([seen.width, seen.height], [128, 64])
    // The 1 px line at x = 10 is 2 px at x = 20, 21; the rest of the row is white.
    const black = seen.row.flatMap((v, x) => (v < 128 ? [x] : []))
    assert.deepEqual(black, [20, 21])
    // Drawn at that resolution, not upscaled: hard edges, no grey between.
    assert.deepEqual(seen.row.slice(19, 23), [255, 0, 0, 255])
    // Scaled back to the frame for the layer: the line is at x = 10.
    const red = (x: number) => frame.pixels[x * 4] as number
    assert.ok(red(10) < 128 && red(5) > 200 && red(15) > 200, [red(5), red(10), red(15)].join())
  } finally {
    await child.close()
  }
})
