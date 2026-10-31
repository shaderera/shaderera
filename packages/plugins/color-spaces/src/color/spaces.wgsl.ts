// Colour spaces as WGSL functions to put in a shader: the ACEScct, ACEScc and BT.1886 curves.
// spaces.ts gives the same values on the CPU, and builds the gamut matrices (gamutMatrix, then
// color-primary's toMat3x3f) a shader multiplies by.

export const SPACES_WGSL = /* wgsl */ `
// Linear light to ACEScct (S-2016-001): a straight toe below 2^-7, log2 above it.
fn linearToAcescct(c: vec3f) -> vec3f {
  let lg = (log2(max(c, vec3f(0.0078125))) + 9.72) / 17.52;
  return select(lg, 10.5402377416545 * c + 0.0729055341958355, c <= vec3f(0.0078125));
}

// ACEScct to linear light (S-2016-001), no more than 65504.
fn acescctToLinear(c: vec3f) -> vec3f {
  let lin = min(exp2(c * 17.52 - 9.72), vec3f(65504.0));
  return select(lin, (c - 0.0729055341958355) / 10.5402377416545, c <= vec3f(0.155251141552511));
}

// Linear light to ACEScc (S-2014-003): log2, eased below 2^-15; 0 and below give its floor.
fn linearToAcescc(c: vec3f) -> vec3f {
  let toe = (log2(exp2(-16.0) + max(c, vec3f(0.0)) * 0.5) + 9.72) / 17.52;
  let lg = (log2(max(c, vec3f(exp2(-15.0)))) + 9.72) / 17.52;
  return select(lg, toe, c < vec3f(exp2(-15.0)));
}

// ACEScc to linear light (S-2014-003), no more than 65504.
fn acesccToLinear(c: vec3f) -> vec3f {
  let lin = exp2(c * 17.52 - 9.72);
  return select(min(lin, vec3f(65504.0)), (lin - exp2(-16.0)) * 2.0, c < vec3f((9.72 - 15.0) / 17.52));
}

// A BT.1886 display value to linear light: V^2.4 (white 1, black 0); below 0 is 0.
fn bt1886ToLinear(c: vec3f) -> vec3f {
  return select(vec3f(0.0), pow(c, vec3f(2.4)), c > vec3f(0.0));
}

// Linear light to a BT.1886 display value: L^(1/2.4); below 0 is 0.
fn linearToBt1886(c: vec3f) -> vec3f {
  return select(vec3f(0.0), pow(c, vec3f(1.0 / 2.4)), c > vec3f(0.0));
}
`
