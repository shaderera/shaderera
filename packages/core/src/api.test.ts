import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import ts from 'typescript'

// docs/api.md: adding or removing an export is a visible change, made here on purpose.
test('the stable and experimental entries export exactly what docs/api.md lists', async () => {
  const keys = async (entry: string) => Object.keys(await import(entry)).sort()
  assert.deepEqual(await keys('./index.ts'), [
    'NotDeterministic',
    'checkDeterminism',
    'diffJson',
    'diffPixels',
    'exportFrames',
    'flattenFrame',
    'frameAt',
    'frameTimes',
    'parseFps',
    'sha256',
  ])
  assert.deepEqual(await keys('./gpu.ts'), [
    'readBuffer',
    'readTexture',
    'videoTexture',
    'yuv420p10ToRgba',
    'yuv420pToRgba',
  ])
  assert.deepEqual(await keys('./host.ts'), [
    'CODE_LIGHT',
    'GRAPHICS_WHITE',
    'checkManifest',
    'dropFrame',
    'finalOnly',
    'formatShaderError',
    'fpsFraction',
    'frameCount',
    'framesOfTimecode',
    'fullDevice',
    'gainAt',
    'gpuCompositor',
    'hdrCompositor',
    'layerInfo',
    'lightChecked',
    'lightReference',
    'matte',
    'opaque',
    'openSource',
    'over',
    'p010Fits',
    'p010Reference',
    'paramDefaults',
    'peakCode',
    'rangeOf',
    'rgb10Reference',
    'sampleClips',
    'sampleTimes',
    'seekable',
    'straight',
    'timecodeOf',
    'toSrt',
    'toVtt',
    'watchShaders',
    'whiteOf',
    'windowCaptions',
    'withVariant',
    'yuvFits',
  ])
})

/**
 * docs/api.md, "The types a film writes against": each declaration there, comments aside, is the
 * one the package exports, so an agent can write against the page without opening a `.d.ts`.
 */
test("docs/api.md's declarations are the exported types, as written", () => {
  const md = readFileSync(join(import.meta.dirname, '..', '..', '..', 'docs', 'api.md'), 'utf8')
  const section = md.slice(md.indexOf('## The types a film writes against'))
  const code = [...section.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n')
  const doc = ts.createSourceFile('api.md.ts', code, ts.ScriptTarget.Latest, true)
  const config = ts.parseJsonConfigFileContent(
    ts.readConfigFile(join(import.meta.dirname, '..', 'tsconfig.json'), ts.sys.readFile).config,
    ts.sys,
    join(import.meta.dirname, '..'),
  )
  const files = ['protocol.ts', 'video.ts'].map((f) => join(import.meta.dirname, f))
  const program = ts.createProgram(files, { ...config.options, noEmit: true })
  const checker = program.getTypeChecker()
  const printer = ts.createPrinter({ removeComments: true })
  const print = (node: ts.Node, file: ts.SourceFile) =>
    printer.printNode(ts.EmitHint.Unspecified, node, file)
  // The exported type aliases, by name, as printed.
  const aliases = new Map<string, string>()
  for (const file of files) {
    const sf = program.getSourceFile(file) as ts.SourceFile
    for (const s of sf.statements)
      if (ts.isTypeAliasDeclaration(s)) aliases.set(s.name.text, print(s, sf))
  }
  const typeOf = (file: string, name: string) => {
    const sf = program.getSourceFile(join(import.meta.dirname, file)) as ts.SourceFile
    const symbol = checker
      .getExportsOfModule(checker.getSymbolAtLocation(sf) as ts.Symbol)
      .find((s) => s.name === name)
    assert.ok(symbol, `${file} exports ${name}`)
    return checker.typeToString(
      checker.getTypeOfSymbol(symbol),
      undefined,
      ts.TypeFormatFlags.NoTruncation,
    )
  }
  const flat = (s: string) => s.replace(/[\s;,]+/g, ' ').trim()
  const names: string[] = []
  for (const s of doc.statements) {
    if (ts.isTypeAliasDeclaration(s)) {
      names.push(s.name.text)
      assert.equal(print(s, doc), aliases.get(s.name.text), `type ${s.name.text}`)
    } else if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        const name = (d.name as ts.Identifier).text
        names.push(name)
        assert.ok(d.type, `${name} has its type written`)
        assert.equal(flat(print(d.type, doc)), flat(typeOf('video.ts', name)), name)
      }
    } else assert.fail(`docs/api.md: only types and consts, not ${print(s, doc)}`)
  }
  assert.deepEqual(names, [
    'Io',
    'DecodedImage',
    'Footage',
    'VideoColour',
    'FootageSpace',
    'videoTexture',
    'AudioClip',
    'Pcm',
    'Frame',
    'Layer',
    'LayerInfo',
  ])
})
