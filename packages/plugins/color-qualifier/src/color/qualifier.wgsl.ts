// The key in a shader: qualify(c, key) gives the matte qualify in qualifier.ts gives on the CPU,
// from the uniform keyUniform packs there. Mixing a grade through it is the shader's own.

export const QUALIFIER_WGSL = /* wgsl */ `
// A key, as keyUniform packs it: hue [centre, half width, softness, 0] in degrees, saturation and
// luma [low, high, softness, 0]. A range left out passes everything.
struct QualifierKey {
  hue: vec4f,
  saturation: vec4f,
  luma: vec4f,
}

// 1 from r.x to r.y, smoothstep to 0 over r.z outside each; a hard step when r.z is 0.
fn qualifierWithin(x: f32, r: vec3f) -> f32 {
  if (r.z > 0.0) { return smoothstep(r.x - r.z, r.x, x) * (1.0 - smoothstep(r.y, r.y + r.z, x)); }
  return select(0.0, 1.0, x >= r.x && x <= r.y);
}

// The HSV hue of a colour in degrees, 0-360; 0 for a grey. color-curves' curvesHue.
fn qualifierHue(c: vec3f) -> f32 {
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

// The matte of a colour under the key, 0-1: its HSV hue, HSV saturation and Rec.709 luma ranges
// multiplied. A grey's hue is 0 (red).
fn qualify(c: vec3f, key: QualifierKey) -> f32 {
  let t = qualifierHue(c) - key.hue.x + 180.0;
  let d = abs(t - 360.0 * floor(t / 360.0) - 180.0);
  let hi = max(c.r, max(c.g, c.b));
  let s = select(0.0, (hi - min(c.r, min(c.g, c.b))) / hi, hi > 0.0);
  let y = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  return qualifierWithin(d, vec3f(0.0, key.hue.yz))
    * qualifierWithin(s, key.saturation.xyz)
    * qualifierWithin(y, key.luma.xyz);
}
`
