/**
 * A WGSL error as the compiler said it. Dawn reports a bad shader once, as an event that can
 * arrive after the call that made it, and then every pipeline built from it fails with "invalid
 * due to a previous error". Asking each module for its compilation info instead gives the
 * compiler's message, line and column in the call that created the module.
 */
export type ShaderWatch = {
  /**
   * Waits for the compilation info of every module created since the last call, and returns
   * their errors, each formatted for a person: message, line, column and the offending line.
   */
  settle(): Promise<string[]>
}

/**
 * Finds where a line of WGSL lives in the project, for an error to point at a file. Returns
 * `path:line`, or undefined when the line is not found exactly once.
 */
export type Locate = (line: string) => string | undefined

type Message = Pick<GPUCompilationMessage, 'type' | 'lineNum' | 'linePos' | 'message'>

/** One compiler error, with the line it is on and where that line is in the project. */
export const formatShaderError = (
  code: string,
  label: string | undefined,
  m: Message,
  locate?: Locate,
): string => {
  const line = code.split(/\r?\n/)[m.lineNum - 1] ?? ''
  const found = line.trim().length >= 8 ? locate?.(line) : undefined
  const name = label ? `shader "${label}"` : 'a shader'
  return [
    `WGSL error in ${name} at ${m.lineNum}:${m.linePos}${found ? ` (${found})` : ''}: ${m.message}`,
    `  ${line.trimEnd()}`,
    `  ${' '.repeat(Math.max(0, m.linePos - 1))}^`,
  ].join('\n')
}

/**
 * Watches the shader modules created on `device`. The device stays the source's own: only
 * `createShaderModule` is wrapped, and it returns the same module it always did.
 */
export const watchShaders = (device: GPUDevice, locate?: Locate): ShaderWatch => {
  const create = device.createShaderModule.bind(device)
  let pending: Promise<string[]>[] = []
  device.createShaderModule = (descriptor: GPUShaderModuleDescriptor) => {
    const module = create(descriptor)
    pending.push(
      module
        .getCompilationInfo()
        .then((info) =>
          info.messages
            .filter((m) => m.type === 'error')
            .map((m) => formatShaderError(descriptor.code, descriptor.label, m, locate)),
        )
        // A lost device rejects; the host reports the loss itself.
        .catch(() => []),
    )
    return module
  }
  return {
    settle: async () => {
      const now = pending
      pending = []
      return (await Promise.all(now)).flat()
    },
  }
}
