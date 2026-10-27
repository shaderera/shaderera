/**
 * Rebuilds io.image's decoder (ADR 0028) from `wasm/image/` and writes it into
 * `src/runner/image-wasm.ts` as base64, so every host and the web player load the same `.wasm` with
 * no loader. Run after a change to the crate: `pnpm --filter shaderera build:wasm`. Needs Rust and
 * the `wasm32-unknown-unknown` target; building the package does not, it uses the file written here.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const cli = join(import.meta.dirname, '..')
const crate = join(cli, 'wasm', 'image')
execFileSync('cargo', ['build', '--release', '--locked', '--target', 'wasm32-unknown-unknown'], {
  cwd: crate,
  stdio: 'inherit',
})
const wasm = readFileSync(
  join(crate, 'target', 'wasm32-unknown-unknown', 'release', 'shaderera_image.wasm'),
)
const module = await WebAssembly.compile(wasm)
const imports = WebAssembly.Module.imports(module)
if (imports.length > 0)
  throw new Error(`the decoder must import nothing: ${JSON.stringify(imports)}`)

// The crates compiled in, and the MIT licence each is used under (zune-* are MIT OR Apache-2.0 OR
// Zlib), kept in the module's header so a web player's notices carry them (player/notices.ts).
type Meta = {
  packages: { name: string; version: string; license: string; manifest_path: string }[]
}
const meta = JSON.parse(
  execFileSync('cargo', ['metadata', '--format-version', '1', '--locked'], {
    cwd: crate,
  }).toString(),
) as Meta
const crates = meta.packages.filter((p) => p.name !== 'shaderera-image')
const licence = (p: Meta['packages'][number]) => {
  const dir = dirname(p.manifest_path)
  const file = ['LICENSE-MIT', 'LICENSE.md', 'LICENSE'].find((f) => existsSync(join(dir, f)))
  // zune-inflate ships no licence file; it is zune-image's, as zune-core's.
  const core = crates.find((c) => c.name === 'zune-core')
  const from = file ? join(dir, file) : core && join(dirname(core.manifest_path), 'LICENSE-MIT')
  if (!from) throw new Error(`no licence file for ${p.name}`)
  return readFileSync(from, 'utf8').replace(/\r\n/g, '\n').trim()
}
const header = [
  "io.image's decoder, built by scripts/image-wasm.ts from wasm/image/ (ADR 0028). Licence notices",
  'of the crates compiled into it:',
  ...crates.flatMap((p) => [
    '',
    `${p.name} ${p.version} (${p.license}, used under MIT)`,
    '',
    ...licence(p).split('\n'),
  ]),
]
writeFileSync(
  join(cli, 'src', 'runner', 'image-wasm.ts'),
  `/*!\n${header.map((l) => (l ? ` * ${l}` : ' *')).join('\n')}\n */
// biome-ignore format: generated
export const IMAGE_WASM = '${wasm.toString('base64')}'
`,
)
console.log(`src/runner/image-wasm.ts: ${wasm.length} bytes of wasm`)
