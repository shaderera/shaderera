import type { Child } from './child.ts'

/** A WebGPU adapter's `info`, as Dawn (the Node host) and Chrome (the browser host) give it. */
export type AdapterInfo = {
  vendor?: string
  architecture?: string
  device?: string
  description?: string
  isFallbackAdapter?: boolean
}

/** The adapter in one line, as capture records keep it: vendor, architecture, description. */
export const adapterLine = (info: AdapterInfo): string =>
  [info.vendor, info.architecture, info.description].filter(Boolean).join(' ')

/** The software renderers WebGPU falls back to without a GPU (or its driver), by what they say. */
const SOFTWARE: [RegExp, string][] = [
  [/swiftshader/i, 'SwiftShader'],
  [/lavapipe/i, 'lavapipe'],
  [/llvmpipe/i, 'llvmpipe'],
  [/softpipe/i, 'softpipe'],
  [/\bwarp\b|basic[- ]render[- ]driver/i, 'WARP (Microsoft Basic Render Driver)'],
]

/**
 * Which software renderer the adapter is, or undefined for a hardware GPU. A renderer named in
 * any of its fields, or else an adapter that says it is the fallback one (`isFallbackAdapter`).
 * Chrome leaves `device` and `description` empty, so its vendor and architecture count too.
 */
export const softwareAdapter = (info: AdapterInfo): string | undefined => {
  const said = [info.vendor, info.architecture, info.device, info.description].join(' ')
  return (
    SOFTWARE.find(([pattern]) => pattern.test(said))?.[1] ??
    (info.isFallbackAdapter ? 'a fallback adapter' : undefined)
  )
}

/**
 * Before a render: a host on a software adapter says so on stderr, and is refused unless the
 * person accepted it (`--software-gpu`). It renders 10–100× slower than a GPU, and nothing else
 * would say why.
 */
export const refuseSoftware = async (child: Child, accepted: boolean): Promise<void> => {
  const { host, software, adapter } = await child.identity()
  if (!software) return
  const line = `The ${host} host's WebGPU adapter is software, ${software} (${adapter}): a render runs 10–100× slower than on a GPU.`
  if (!accepted)
    throw new Error(
      `${line} Pass --software-gpu to render on it anyway, or give the host a GPU: npx shaderera doctor says what to check.`,
    )
  process.stderr.write(`${line}\n`)
}
