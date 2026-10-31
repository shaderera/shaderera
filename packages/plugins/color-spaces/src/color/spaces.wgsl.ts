// Colour spaces as WGSL functions to put in a shader: the ACEScct, ACEScc and BT.1886 curves,
// and the camera curves (S-Log3, LogC3, LogC4, V-Log, Canon Log 3), named `<transfer>ToLinear`.
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

// The camera curves take and give code values, a 10-bit code / 1023. log10(x) is
// log2(x) * 0.30103, and 10^x exp2(x * 3.32193).

// S-Log3 to linear light (Sony): a line below code 171.21.
fn slog3ToLinear(c: vec3f) -> vec3f {
  let lg = exp2((c * 1023.0 - 420.0) / 261.5 * 3.321928094887362) * 0.19 - 0.01;
  return select(lg, (c * 1023.0 - 95.0) * 0.01125 / (171.2102946929 - 95.0), c < vec3f(171.2102946929 / 1023.0));
}

// Linear light to S-Log3: log10 above 0.01125, a line below; 0 is code 95, 18% grey 420.
fn linearToSlog3(c: vec3f) -> vec3f {
  let lg = (420.0 + log2((max(c, vec3f(0.01125)) + 0.01) / 0.19) * 0.3010299956639812 * 261.5) / 1023.0;
  return select(lg, (c * (171.2102946929 - 95.0) / 0.01125 + 95.0) / 1023.0, c < vec3f(0.01125));
}

// ARRI LogC3 at EI 800 to linear light: a line below 0.149658.
fn logc3ToLinear(c: vec3f) -> vec3f {
  let lg = (exp2((c - 0.385537) / 0.24719 * 3.321928094887362) - 0.052272) / 5.555556;
  return select(lg, (c - 0.092809) / 5.367655, c <= vec3f(0.149658));
}

// Linear light to ARRI LogC3 at EI 800: log10 above 0.010591; 18% grey is 0.391007.
fn linearToLogc3(c: vec3f) -> vec3f {
  let lg = 0.24719 * log2(5.555556 * max(c, vec3f(0.010591)) + 0.052272) * 0.3010299956639812 + 0.385537;
  return select(lg, 5.367655 * c + 0.092809, c <= vec3f(0.010591));
}

// ARRI LogC4 to linear light: log2 from code value 0, a line below. a = (2^18 - 16) / 117.45,
// b = 928 / 1023, c = 95 / 1023, the toe's slope 0.1135972 and break -0.018057.
fn logc4ToLinear(c: vec3f) -> vec3f {
  let lg = (exp2((c - 95.0 / 1023.0) * (14.0 * 1023.0 / 928.0) + 6.0) - 64.0) / (262128.0 / 117.45);
  return select(lg, c * 0.1135972086105891 - 0.01805699611991131, c < vec3f(0.0));
}

// Linear light to ARRI LogC4: 0 is code 95, 18% grey 0.278396; a line below -0.018057.
fn linearToLogc4(c: vec3f) -> vec3f {
  let x = max(c, vec3f(-0.01805699611991131));
  let lg = (log2(262128.0 / 117.45 * x + 64.0) - 6.0) / 14.0 * (928.0 / 1023.0) + 95.0 / 1023.0;
  return select(lg, (c + 0.01805699611991131) / 0.1135972086105891, c < vec3f(-0.01805699611991131));
}

// Panasonic V-Log to linear light: a line below 0.181.
fn vlogToLinear(c: vec3f) -> vec3f {
  let lg = exp2((c - 0.598206) / 0.241514 * 3.321928094887362) - 0.00873;
  return select(lg, (c - 0.125) / 5.6, c < vec3f(0.181));
}

// Linear light to Panasonic V-Log: log10 above 0.01; 0 is 0.125 (code 128), 18% grey 433.
fn linearToVlog(c: vec3f) -> vec3f {
  let lg = 0.241514 * log2(max(c, vec3f(0.01)) + 0.00873) * 0.3010299956639812 + 0.598206;
  return select(lg, 5.6 * c + 0.125, c < vec3f(0.01));
}

// Canon Log 3 to linear light (full range): log10 both ways from a line through code 128,
// scaled by 0.9 (Canon's linear is 1 at 90% white).
fn clog3ToLinear(c: vec3f) -> vec3f {
  let hi = (exp2((c - 0.12240537) / 0.36726845 * 3.321928094887362) - 1.0) / 14.98325;
  let lo = -(exp2((0.12783901 - c) / 0.36726845 * 3.321928094887362) - 1.0) / 14.98325;
  let mid = (c - 0.12512219) / 1.9754798;
  return 0.9 * select(select(hi, mid, c <= vec3f(0.15277891)), lo, c < vec3f(0.097465473));
}

// Linear light to Canon Log 3: 0 is code 128, 18% grey 351.
fn linearToClog3(c: vec3f) -> vec3f {
  let x = c / 0.9;
  let hi = 0.36726845 * log2(14.98325 * max(x, vec3f(0.014)) + 1.0) * 0.3010299956639812 + 0.12240537;
  let lo = -0.36726845 * log2(1.0 - 14.98325 * min(x, vec3f(-0.014))) * 0.3010299956639812 + 0.12783901;
  return select(select(hi, 1.9754798 * x + 0.12512219, x <= vec3f(0.014)), lo, x < vec3f(-0.014));
}
`
