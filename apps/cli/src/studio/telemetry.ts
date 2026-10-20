// The studio's telemetry switch (docs/studio.md). The CLI sends nothing itself: it tells the page
// whether it may (`telemetry` in cli-hello and /info), and the page sends counts only.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** The user's Shaderera config: `~/.shaderera/config.json`, beside tokens.json. */
export const configFile = (): string => join(homedir(), '.shaderera', 'config.json')

type Config = { telemetry?: boolean; telemetryNotice?: boolean }

const readConfig = (): Config => {
  try {
    return existsSync(configFile())
      ? (JSON.parse(readFileSync(configFile(), 'utf8')) as Config)
      : {}
  } catch {
    return {}
  }
}

const writeConfig = (change: Config): string => {
  const file = configFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ ...readConfig(), ...change }, null, 2)}\n`)
  return file
}

/** Whether the page may send telemetry, and why: `SHADERERA_TELEMETRY=0` wins over the config. */
export const telemetryStatus = (): { on: boolean; by: 'env' | 'config' | 'default' } => {
  if (process.env.SHADERERA_TELEMETRY === '0') return { on: false, by: 'env' }
  const { telemetry } = readConfig()
  return telemetry === undefined ? { on: true, by: 'default' } : { on: telemetry, by: 'config' }
}

export const setTelemetry = (on: boolean): string => writeConfig({ telemetry: on })

export const NOTICE = `Studio telemetry: the studio page reports usage counts to shaderera.com, which stores them in
PostHog: opened, paired (the CLI's version and OS), edits, renders and exports (format, length,
time taken), shares and error codes. Never your code, file names, params, frames or titles, and
this CLI sends nothing itself. Turn it off: \`npx shaderera telemetry off\` or SHADERERA_TELEMETRY=0.`

/** The notice, the first time only: true when it is shown now (and noted as shown). */
export const noticeOnce = (print: (text: string) => void): boolean => {
  if (readConfig().telemetryNotice) return false
  print(NOTICE)
  writeConfig({ telemetryNotice: true })
  return true
}
