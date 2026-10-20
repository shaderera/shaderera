// The studio's telemetry switch (docs/studio.md). The CLI sends nothing itself: it tells the page
// whether it may (`telemetry` in cli-hello and /info), and the page sends counts only.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** The user's Shaderera config: `~/.shaderera/config.json`, beside tokens.json. */
export const configFile = (): string => join(homedir(), '.shaderera', 'config.json')

type Config = { telemetry?: boolean; telemetryNotice?: boolean }

/** The config: `{}` when there is none, null when it cannot be read (it may hold an opt-out). */
const readConfig = (): Config | null => {
  if (!existsSync(configFile())) return {}
  try {
    const config: unknown = JSON.parse(readFileSync(configFile(), 'utf8'))
    return config && typeof config === 'object' && !Array.isArray(config)
      ? (config as Config)
      : null
  } catch {
    return null
  }
}

/** Writes through a temporary name, and never over a config that cannot be read. */
const writeConfig = (change: Config): string => {
  const file = configFile()
  const config = readConfig()
  if (!config) throw new Error(`${file} cannot be read: fix it or delete it.`)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ ...config, ...change }, null, 2)}\n`)
  renameSync(tmp, file)
  return file
}

/** Whether the page may send telemetry, and why: `SHADERERA_TELEMETRY=0` wins over the config. */
export const telemetryStatus = (): { on: boolean; by: 'env' | 'config' | 'default' } => {
  if (process.env.SHADERERA_TELEMETRY === '0') return { on: false, by: 'env' }
  const config = readConfig()
  // A config that cannot be read may hold an opt-out: off until it is fixed.
  if (!config) return { on: false, by: 'config' }
  const { telemetry } = config
  return telemetry === undefined ? { on: true, by: 'default' } : { on: telemetry, by: 'config' }
}

export const setTelemetry = (on: boolean): string => writeConfig({ telemetry: on })

export const NOTICE = `Studio telemetry: the studio page reports usage counts to shaderera.com, which stores them in
PostHog: opened, paired (the CLI's version and OS), edits, renders and exports (format, length,
time taken), shares and error codes. Never your code, file names, params, frames or titles, and
this CLI sends nothing itself. Turn it off: \`npx shaderera telemetry off\` or SHADERERA_TELEMETRY=0.`

/** The notice, the first time only: true when it is shown now (and noted as shown). */
export const noticeOnce = (print: (text: string) => void): boolean => {
  // Unreadable: telemetry is off (telemetryStatus), and the file is left as it is.
  const config = readConfig()
  if (!config || config.telemetryNotice) return false
  print(NOTICE)
  writeConfig({ telemetryNotice: true })
  return true
}
