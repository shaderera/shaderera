// The tone maps as WGSL functions to put in a film's own shader: linear light in (Rec.709/sRGB
// primaries, exposed and white balanced, 0 up), linear display-referred light out, 0–1. Khronos
// PBR Neutral and AgX, each as its reference has it; tonemap.ts gives the same values on the CPU.
// Exposure, white balance, the sRGB encoding and dither stay in the film's shader, around them.

export const TONEMAP_WGSL = /* wgsl */ `
// Khronos PBR Neutral (KhronosGroup/ToneMapping, PBR_Neutral): colours below the shoulder pass
// through as they are; the highlights roll off to white and desaturate.
fn pbrNeutral(cIn: vec3f) -> vec3f {
  let start = 0.8 - 0.04;
  let desaturation = 0.15;
  let x = min(cIn.r, min(cIn.g, cIn.b));
  let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
  var c = cIn - offset;
  let peak = max(c.r, max(c.g, c.b));
  if (peak < start) { return c; }
  let d = 1.0 - start;
  let newPeak = 1.0 - d * d / (peak + d - start);
  c *= newPeak / peak;
  let g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(c, vec3f(newPeak), g);
}

// AgX's sigmoid, the minimal polynomial fit (iolite-engine.com/blog_posts/minimal_agx_implementation).
fn agxContrast(x: vec3f) -> vec3f {
  let x2 = x * x;
  let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x
    - 0.00232;
}

// AgX as three.js r186 has it (AgXToneMapping, after Filament and Blender), in Rec.2020: the
// colour inset, a log2 encoding from -12.47393 to 4.026069 EV, the sigmoid, the outset, and the
// 2.2 power that turns the sigmoid's display values back into linear light.
fn agx(cIn: vec3f) -> vec3f {
  let srgbTo2020 = mat3x3f(
    vec3f(0.6274, 0.0691, 0.0164),
    vec3f(0.3293, 0.9195, 0.0880),
    vec3f(0.0433, 0.0113, 0.8956),
  );
  let rec2020ToSrgb = mat3x3f(
    vec3f(1.6605, -0.1246, -0.0182),
    vec3f(-0.5876, 1.1329, -0.1006),
    vec3f(-0.0728, -0.0083, 1.1187),
  );
  let inset = mat3x3f(
    vec3f(0.856627153315983, 0.137318972929847, 0.11189821299995),
    vec3f(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
    vec3f(0.0482516061458583, 0.101439036467562, 0.811302368396859),
  );
  let outset = mat3x3f(
    vec3f(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
    vec3f(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
    vec3f(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405),
  );
  let minEv = -12.47393;
  let maxEv = 4.026069;
  var c = inset * (srgbTo2020 * cIn);
  c = clamp((log2(max(c, vec3f(1e-10))) - minEv) / (maxEv - minEv), vec3f(0.0), vec3f(1.0));
  c = max(outset * agxContrast(c), vec3f(0.0));
  // pow(0, y) is undefined in WGSL: 0 stays 0.
  c = select(vec3f(0.0), pow(c, vec3f(2.2)), c > vec3f(0.0));
  return clamp(rec2020ToSrgb * c, vec3f(0.0), vec3f(1.0));
}
`
