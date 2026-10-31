// The hue curves applied in a shader, from the table hueCurvesLut (curves.ts) bakes and
// lutTexture (color-lut) puts on the GPU. applyHueCurves in curves.ts gives the same values on the
// CPU. The RGB curves need nothing here: they are a 1D LUT, and color-lut's lut1d applies them.

export const CURVES_WGSL = /* wgsl */ `
// The HSV hue of a colour in degrees, 0-360; 0 for a grey, which has none.
fn curvesHue(c: vec3f) -> f32 {
  let hi = max(c.r, max(c.g, c.b));
  let chroma = hi - min(c.r, min(c.g, c.b));
  if (chroma <= 0.0) { return 0.0; }
  var h: f32;
  if (hi == c.r) { h = (c.g - c.b) / chroma; }
  else if (hi == c.g) { h = (c.b - c.r) / chroma + 2.0; }
  else { h = (c.r - c.g) / chroma + 4.0; }
  let d = h * 60.0;
  return d - 360.0 * floor(d / 360.0);
}

// A colour through the hue curves, both read at its own HSV hue, linear between the table's two
// entries either side and around 360: the hue turned by the offset, keeping the largest and
// smallest channel, then the saturation scaled around Rec.709 luma, which that keeps.
fn applyHueCurves(table: texture_2d<f32>, c: vec3f) -> vec3f {
  let n = textureDimensions(table).x;
  let hue = curvesHue(c);
  let p = hue / 360.0 * f32(n);
  let i = u32(floor(p)) % n;
  let e = mix(
    textureLoad(table, vec2u(i, 0u), 0).rg,
    textureLoad(table, vec2u((i + 1u) % n, 0u), 0).rg,
    p - floor(p),
  );
  let lo = min(c.r, min(c.g, c.b));
  let chroma = max(c.r, max(c.g, c.b)) - lo;
  let t = (hue + e.y) / 60.0;
  let h = t - 6.0 * floor(t / 6.0);
  let share = clamp(vec3f(abs(h - 3.0) - 1.0, 2.0 - abs(h - 2.0), 2.0 - abs(h - 4.0)), vec3f(0.0), vec3f(1.0));
  let turned = lo + chroma * share;
  let luma = dot(turned, vec3f(0.2126, 0.7152, 0.0722));
  return luma + e.x * (turned - luma);
}
`
