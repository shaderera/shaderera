/**
 * What a command found, in one shape for every command (T2, decision 0011): `--json` prints them in
 * an envelope an agent reads without parsing prose. Commands add findings as they go; run.ts adds
 * the error that stopped a command.
 */
export type Finding = {
  /** A stable id: a review check (`end-hold`), `determinism`, `shader`, `usage`, `environment`… */
  code: string
  /** `error` fails the command; `warning` and `info` never do. */
  severity: 'error' | 'warning' | 'info'
  message: string
  /** Seconds of the composition the finding is about. */
  t?: number[]
  /** A project file and line (a shader, a stamped object). */
  file?: string
  line?: number
  column?: number
  /** Where in the frame, in pixels: x, y, width, height. */
  bbox?: [number, number, number, number]
  /** The variant or job it is about. */
  output?: string
  /** What was measured, when that is not the message. */
  measured?: string
}

/**
 * The exit codes, documented in docs/cli.md: 0 the work ran and nothing failed; 1 it ran and found
 * a failure (a check, a review requirement, a frame that depends on history, a missing tool doctor
 * needs); 2 it could not run (a usage error, a missing tool, a project that does not build or open,
 * a shader that does not compile, a render that threw).
 */
export const EXIT = { ok: 0, failed: 1, error: 2 } as const

export const findings: Finding[] = []

/** Records a finding (run.ts prints them with --json). */
export const found = (f: Finding) => {
  findings.push(f)
}

/**
 * The finding for an error that stopped a command: its code, and file:line for a shader. An error
 * that knows where in the film it came from carries it as `at` (a throw in the source's code, a
 * build error: node/child.ts, node/build.ts), which the finding takes over.
 */
export const errorFinding = (e: unknown): Finding => {
  const message = e instanceof Error ? e.message : String(e)
  const at = (e as { at?: Partial<Finding> } | undefined)?.at
  if (at) return { code: 'error', severity: 'error', message, ...at }
  const code = (e as { code?: unknown })?.code
  const shader =
    /WGSL error in (?:shader "[^"]*"|a shader) at (\d+):(\d+)(?: \(([^:)]+):(\d+)\))?/.exec(message)
  const kind =
    typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS')
      ? 'usage'
      : shader
        ? 'shader'
        : /needs ffmpeg|ffprobe cannot|GPU adapter|cannot encode with|Chrome/.test(message)
          ? 'environment'
          : /not deterministic/.test(message)
            ? 'determinism'
            : /device was lost|WebGPU reported/.test(message)
              ? 'gpu'
              : 'error'
  return {
    code: kind,
    severity: 'error',
    message,
    ...(shader?.[3] ? { file: shader[3], line: Number(shader[4]) } : {}),
    ...(shader && !shader[3] ? { line: Number(shader[1]), column: Number(shader[2]) } : {}),
  }
}
