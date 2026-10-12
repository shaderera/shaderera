import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatShaderError, watchShaders } from './shaders.ts'

const code = 'struct U { a: f32 }\n@compute @workgroup_size(1) fn main() {\n  let set = 1.0;\n}\n'
const reserved = { type: 'error', lineNum: 3, linePos: 7, message: "'set' is a reserved keyword" }

/** A device whose modules report `messages` for any code. */
const fakeDevice = (messages: object[]) => {
  const made: object[] = []
  const device = {
    createShaderModule(descriptor: GPUShaderModuleDescriptor) {
      const module = {
        label: descriptor.label,
        getCompilationInfo: async () => ({ messages }),
      }
      made.push(module)
      return module
    },
  }
  return { device: device as unknown as GPUDevice, made }
}

test('formatShaderError gives the message, the line and a caret under the column', () => {
  const text = formatShaderError(code, 'field', reserved as GPUCompilationMessage)
  assert.equal(
    text,
    [
      `WGSL error in shader "field" at 3:7: 'set' is a reserved keyword`,
      '    let set = 1.0;',
      '        ^',
    ].join('\n'),
  )
})

test('formatShaderError names the project file when the line is found once', () => {
  const text = formatShaderError(code, undefined, reserved as GPUCompilationMessage, (line) =>
    line.includes('let set') ? 'src/field.wgsl:3' : undefined,
  )
  assert.match(text, /^WGSL error in a shader at 3:7 \(src\/field\.wgsl:3\):/)
})

test('watchShaders returns the same module and settles its errors once', async () => {
  const { device, made } = fakeDevice([reserved, { ...reserved, type: 'warning' }])
  const watch = watchShaders(device)
  const module = device.createShaderModule({ code, label: 'field' })
  assert.equal(module, made[0])
  const errors = await watch.settle()
  assert.equal(errors.length, 1)
  assert.match(errors[0] ?? '', /reserved keyword/)
  assert.deepEqual(await watch.settle(), [])
})

test('watchShaders reports nothing for a module that compiles', async () => {
  const { device } = fakeDevice([])
  const watch = watchShaders(device)
  device.createShaderModule({ code })
  assert.deepEqual(await watch.settle(), [])
})
