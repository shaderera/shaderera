import type { Json, Manifest } from './protocol.ts'

/** The params a host passes when nobody has changed them: each property's `default` in the schema. */
export const paramDefaults = (manifest: Manifest): { [key: string]: Json } => {
  const properties = manifest.params?.properties
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return {}
  const defaults: { [key: string]: Json } = {}
  for (const [key, schema] of Object.entries(properties as { [key: string]: Json })) {
    const value = (schema as { default?: Json } | null)?.default
    if (value !== undefined) defaults[key] = value
  }
  return defaults
}
