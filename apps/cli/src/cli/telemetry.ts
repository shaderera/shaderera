import { NOTICE, setTelemetry, telemetryStatus } from '../studio/telemetry.ts'
import { EXIT } from './findings.ts'

/**
 * `shaderera telemetry off|on|status`: whether the studio page may count how the studio is used
 * (docs/studio.md). Kept in ~/.shaderera/config.json; SHADERERA_TELEMETRY=0 turns it off whatever
 * the config says.
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const [what = 'status'] = argv
  if (what === 'on' || what === 'off') {
    const file = setTelemetry(what === 'on')
    console.log(`studio telemetry ${what} (${file})`)
    if (what === 'on' && telemetryStatus().by === 'env')
      console.log('  SHADERERA_TELEMETRY=0 still turns it off in this shell')
    return EXIT.ok
  }
  if (what !== 'status') throw new Error('Usage: shaderera telemetry off|on|status')
  const { on, by } = telemetryStatus()
  console.log(
    `studio telemetry ${on ? 'on' : 'off'}${by === 'env' ? ' (SHADERERA_TELEMETRY=0)' : by === 'config' ? ' (shaderera telemetry)' : ' (the default)'}`,
  )
  console.log(NOTICE)
  return EXIT.ok
}
