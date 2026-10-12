/**
 * Where a frame depends on history: renders t fresh, then again after rendering `before`, in two
 * Node children, and prints the bounding box, count and size of the pixels that differ.
 *
 *   node apps/cli/scripts/history.ts <project dir> <t> <before> [--variant name]
 */
import { parseArgs } from 'node:util'
import { open } from '../src/cli/args.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { variant: { type: 'string' } },
})
const [root = '.', at = '0', prior = '0'] = positionals
const t = Number(at)
const before = Number(prior)

const fresh = await open({ root, variant: values.variant })
const a = (await fresh.child.render(t, 'final')).pixels
await fresh.child.close()
const after = await open({ root, variant: values.variant })
await after.child.render(before, 'final')
const b = (await after.child.render(t, 'final')).pixels
await after.child.close()

const { width } = fresh.project.manifest
let n = 0
let max = 0
let [x0, y0, x1, y1] = [Infinity, Infinity, -1, -1]
for (let i = 0; i < a.length; i += 4) {
  const d = Math.max(
    Math.abs(a[i] - b[i]),
    Math.abs(a[i + 1] - b[i + 1]),
    Math.abs(a[i + 2] - b[i + 2]),
  )
  if (d === 0) continue
  n++
  max = Math.max(max, d)
  const x = (i / 4) % width
  const y = Math.floor(i / 4 / width)
  x0 = Math.min(x0, x)
  y0 = Math.min(y0, y)
  x1 = Math.max(x1, x)
  y1 = Math.max(y1, y)
}
console.log(
  JSON.stringify({ t, before, differing: n, maxDifference: max, box: n ? [x0, y0, x1, y1] : null }),
)
