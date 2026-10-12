import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { arch, platform, release } from 'node:os'

const first = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10_000 })
  return r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0]?.trim() || undefined : undefined
}

const VERSION: string = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version

/** The Shaderera package's version. */
export const shadereraVersion = (): string => VERSION

/** `ffmpeg -version`'s first line, or undefined without ffmpeg. */
export const ffmpegVersion = () => first('ffmpeg', ['-version'])

/** The machine as measured now: OS, CPU architecture, GPU, Node, ffmpeg and Shaderera. */
export const environment = () => ({
  os: `${platform()} ${release()} ${arch()}`,
  gpu:
    first('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader']) ??
    (platform() === 'win32'
      ? first('powershell', [
          '-NoProfile',
          '-Command',
          '(Get-CimInstance Win32_VideoController | Select-Object -First 1).Name',
        ])
      : undefined) ??
    'unknown',
  node: process.version,
  ffmpeg: ffmpegVersion() ?? 'not found',
  shaderera: shadereraVersion(),
})
