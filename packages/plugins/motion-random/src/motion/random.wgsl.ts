// The hash of random.ts as WGSL functions to put in a shader: the same 32 bits for the same
// integer, on the GPU and on the CPU.

export const RANDOM_WGSL = /* wgsl */ `
// A 32-bit hash of an integer (PCG).
fn hash(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

// A hash as a number in [0, 1): its top 24 bits, all an f32 holds exactly.
fn rnd(v: u32) -> f32 {
  return f32(hash(v) >> 8u) / 16777216.0;
}
`
