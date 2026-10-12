/**
 * What a host asks the adapter for (decision 0011: nothing hides the GPU): every feature the
 * adapter offers, and every limit at the adapter's maximum, so a source sees the whole GPU in
 * either host. Requesting a feature enables it and changes nothing else; a source tests
 * `host.gpu.features` before it relies on one, because another machine's adapter may lack it.
 */
export const fullDevice = (adapter: GPUAdapter): GPUDeviceDescriptor => {
  const requiredLimits: Record<string, number> = {}
  for (const key in adapter.limits) {
    const value = (adapter.limits as unknown as Record<string, unknown>)[key]
    if (typeof value === 'number') requiredLimits[key] = value
  }
  return { requiredFeatures: [...adapter.features] as GPUFeatureName[], requiredLimits }
}
