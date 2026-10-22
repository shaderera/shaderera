/*
 * The HDR compositor (docs/adr/0023, decision 1): `over` premultiplied in linear BT.2020 light in
 * an f32 accumulator, PQ, 10-bit R'G'B' codes, P010 from those codes, and the light meter. Held to
 * the float64 reference in hdr.ts (decision 4).
 */
import { type GpuLayer, gpuStage } from './compositor.ts'
import {
  BT709_TO_BT2020,
  CODE_LIGHT,
  LINEAR_WHITE,
  type LightLevels,
  levelsOf,
  PQ,
  PQ_PEAK,
  peakCode,
  TOP,
  whiteOf,
} from './hdr.ts'
import type { Hdr10 } from './protocol.ts'

/**
 * `rgb10`: the PQ R'G'B' codes, one little-endian 32-bit word a pixel, R in bits 0–9, G 10–19,
 * B 20–29 (ffmpeg's `x2bgr10le`). `p010`: from those codes, Y'CbCr 4:2:0 in BT.2020 non-constant
 * luminance, narrow range, chroma sited top-left (BT.2100), 16-bit words with the code in the top
 * ten bits: the Y' plane, then Cb and Cr interleaved. Both are the frame matted over black.
 */
export type HdrOutput = 'rgb10' | 'p010'

/** Whether a frame size can come out as `p010` (one thread per 2×2 block). */
export const p010Fits = (width: number, height: number) => width % 2 === 0 && height % 2 === 0

const f = (n: number) => n.toPrecision(17)
const M = BT709_TO_BT2020

const WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  // 0 premultiplied, 1 straight, 2 opaque
  alpha: u32,
  // 1: the texture's format decodes sRGB to linear on load; encode it back
  srgb: u32,
  hasDepth: u32,
  soft: f32,
  // 0 SDR code values (sRGB), 1 linear (1.0 is ${LINEAR_WHITE} cd/m²), 2 PQ code values
  transfer: u32,
  // 1: BT.709 primaries, taken to BT.2020
  bt709: u32,
  // Graphics White over PQ's peak: where an SDR layer's white goes
  white: f32,
  // 1: TPDF dither before the 10-bit quantisation
  dither: u32,
  frame: u32,
  // The highest code the mastering display's peak allows
  peak: u32,
}
@group(0) @binding(0) var<storage, read_write> acc: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> nearest: array<f32>;
@group(0) @binding(2) var<uniform> P: Params;
@group(0) @binding(3) var color: texture_2d<f32>;
@group(0) @binding(4) var<storage, read> depth: array<f32>;
@group(0) @binding(5) var<storage, read_write> codes: array<u32>;
@group(0) @binding(6) var<storage, read_write> outWords: array<u32>;
// One count per max(R', G', B') code; the last counts pixels whose light passed PQ's peak.
@group(0) @binding(7) var<storage, read_write> histogram: array<atomic<u32>, ${TOP + 2}>;

const FAR = 3.0e38;
fn finite(d: f32) -> f32 {
  if ((bitcast<u32>(d) & 0x7f800000u) == 0x7f800000u) { return FAR; }
  return d;
}
fn toSrgb(c: f32) -> f32 {
  if (c <= 0.0031308) { return 12.92 * c; }
  return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}
fn fromSrgb(c: f32) -> f32 {
  if (c <= 0.04045) { return c / 12.92; }
  return pow((c + 0.055) / 1.055, 2.4);
}
fn pqDecode(e: f32) -> f32 {
  if (e <= 0.0) { return 0.0; }
  let p = pow(e, 1.0 / ${f(PQ.m2)});
  return pow(max(p - ${f(PQ.c1)}, 0.0) / (${f(PQ.c2)} - ${f(PQ.c3)} * p), 1.0 / ${f(PQ.m1)});
}
fn pqEncode(y: f32) -> f32 {
  if (y <= 0.0) { return 0.0; }
  let p = pow(y, ${f(PQ.m1)});
  return pow((${f(PQ.c1)} + ${f(PQ.c2)} * p) / (1.0 + ${f(PQ.c3)} * p), ${f(PQ.m2)});
}

@compute @workgroup_size(8, 8)
fn init(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.width || g.y >= P.height) { return; }
  let i = g.y * P.width + g.x;
  acc[i] = vec4<f32>(0.0);
  nearest[i] = FAR;
}

// One layer over what is there, in linear BT.2020 light (1.0 is ${PQ_PEAK} cd/m²), premultiplied.
@compute @workgroup_size(8, 8)
fn layer(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.width || g.y >= P.height) { return; }
  let i = g.y * P.width + g.x;
  var c = textureLoad(color, vec2<i32>(g.xy), 0);
  if (P.srgb == 1u) { c = vec4<f32>(toSrgb(c.r), toSrgb(c.g), toSrgb(c.b), c.a); }
  var a = c.a;
  if (P.alpha == 2u) { a = 1.0; }
  if (a <= 0.0) { return; }
  var seen = 1.0;
  if (P.hasDepth == 1u) {
    let d = finite(depth[i]);
    let z = nearest[i];
    if (d > z) {
      seen = 0.0;
      if (P.soft > 0.0) { seen = max(0.0, 1.0 - (d - z) / P.soft); }
    }
    if (seen == 0.0) { return; }
    if (a >= 1.0 && d < z) { nearest[i] = d; }
  }
  // The layer's straight colour, then its light.
  var s = c.rgb;
  if (P.alpha == 0u) { s = s / a; }
  var light: vec3<f32>;
  if (P.transfer == 1u) {
    light = s * ${f(LINEAR_WHITE / PQ_PEAK)};
  } else if (P.transfer == 2u) {
    let e = clamp(s, vec3<f32>(0.0), vec3<f32>(1.0));
    light = vec3<f32>(pqDecode(e.r), pqDecode(e.g), pqDecode(e.b));
  } else {
    let e = clamp(s, vec3<f32>(0.0), vec3<f32>(1.0));
    light = vec3<f32>(fromSrgb(e.r), fromSrgb(e.g), fromSrgb(e.b)) * P.white;
  }
  if (P.bt709 == 1u) {
    light = vec3<f32>(
      dot(light, vec3<f32>(${f(M[0])}, ${f(M[1])}, ${f(M[2])})),
      dot(light, vec3<f32>(${f(M[3])}, ${f(M[4])}, ${f(M[5])})),
      dot(light, vec3<f32>(${f(M[6])}, ${f(M[7])}, ${f(M[8])})),
    );
  }
  let k = a * seen;
  let prev = acc[i];
  acc[i] = vec4<f32>(light * k + prev.rgb * (1.0 - k), k + prev.a * (1.0 - k));
}

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
// TPDF noise in (-1, 1) codes, seeded by the frame index (hdr.ts tpdf).
fn tpdf(x: u32, y: u32, channel: u32) -> f32 {
  let h = pcg(pcg(pcg(P.frame) + y) + x);
  let a = pcg(h + 2u * channel) >> 8u;
  let b = pcg(h + 2u * channel + 1u) >> 8u;
  return f32(i32(a + b) - 16777216) / 16777216.0;
}

// Matted over black, negatives clamped, PQ, 10-bit codes: dithered where declared, never on black,
// and never by the dither alone above the peak's code.
@compute @workgroup_size(8, 8)
fn encode(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= P.width || g.y >= P.height) { return; }
  let i = g.y * P.width + g.x;
  let v = max(acc[i].rgb, vec3<f32>(0.0));
  // Past PQ's peak by more than f32's rounding of light declared at it.
  if (any(v > vec3<f32>(1.000001))) { atomicAdd(&histogram[${TOP + 1}], 1u); }
  var word = 0u;
  for (var k = 0u; k < 3u; k++) {
    let s = pqEncode(min(v[k], 1.0)) * ${TOP}.0;
    let q = round(s);
    var d = q;
    if (P.dither == 1u && s > 0.0) { d = round(s + tpdf(g.x, g.y, k)); }
    d = min(clamp(d, 0.0, ${TOP}.0), max(q, f32(P.peak)));
    word = word | (u32(d) << (10u * k));
  }
  codes[i] = word;
}

// The light meter: a histogram of each pixel's max(R', G', B') code, one 64×64 tile a workgroup.
var<workgroup> bins: array<atomic<u32>, ${TOP + 1}>;
@compute @workgroup_size(16, 16)
fn meter(@builtin(workgroup_id) w: vec3<u32>, @builtin(local_invocation_index) l: u32) {
  for (var b = l; b <= ${TOP}u; b += 256u) { atomicStore(&bins[b], 0u); }
  workgroupBarrier();
  for (var k = 0u; k < 16u; k++) {
    let x = w.x * 64u + l % 16u + 16u * (k % 4u);
    let y = w.y * 64u + l / 16u + 16u * (k / 4u);
    if (x < P.width && y < P.height) {
      let c = codes[y * P.width + x];
      atomicAdd(&bins[max(c & 1023u, max((c >> 10u) & 1023u, (c >> 20u) & 1023u))], 1u);
    }
  }
  workgroupBarrier();
  for (var b = l; b <= ${TOP}u; b += 256u) {
    let n = atomicLoad(&bins[b]);
    if (n > 0u) { atomicAdd(&histogram[b], n); }
  }
}

fn codeAt(x: i32, y: i32) -> vec3<i32> {
  let c = codes[u32(clamp(y, 0, i32(P.height) - 1)) * P.width + u32(clamp(x, 0, i32(P.width) - 1))];
  return vec3<i32>(i32(c & 1023u), i32((c >> 10u) & 1023u), i32((c >> 20u) & 1023u));
}
// Y' = 64 + 876 (0.2627 R' + 0.6780 G' + 0.0593 B') with R' = R / 1023, rounded half up, exactly
// in integers: 876 / (1023 × 10000) = 219 / 2557500.
fn luma(c: vec3<i32>) -> u32 {
  let s = u32(2627 * c.r + 6780 * c.g + 593 * c.b);
  return 64u + (s * 219u + 1278750u) / 2557500u;
}
// 512 + round(28 t / k), half up, exactly in 32-bit integers for |t| up to 16 k.
fn chroma(t: i32, k: i32) -> u32 {
  let q = t / k;
  let r = t - q * k;
  let n = 56 * r + k;
  var f = n / (2 * k);
  if (n < 0 && f * 2 * k != n) { f = f - 1; }
  return u32(512 + 28 * q + f);
}

// One thread per 2×2 block: its four Y' and the chroma sited at its top-left sample, [1 2 1]/4
// across and down. Cb = 512 + 896 Σw(B' - Y') / (16 × 1.8814) = 512 + 28 Σw(9407 B - 2627 R -
// 6780 G) / (1023 × 9407); Cr likewise with 1.4746 and 7373.
@compute @workgroup_size(8, 8)
fn p010(@builtin(global_invocation_id) g: vec3<u32>) {
  let x0 = g.x * 2u;
  let y0 = g.y * 2u;
  if (x0 >= P.width || y0 >= P.height) { return; }
  for (var r = 0u; r < 2u; r++) {
    let y = i32(y0 + r);
    let a = luma(codeAt(i32(x0), y));
    let b = luma(codeAt(i32(x0) + 1, y));
    outWords[(u32(y) * P.width + x0) / 2u] = (a << 6u) | (b << 22u);
  }
  var tb = 0;
  var tr = 0;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let w = (2 - abs(dx)) * (2 - abs(dy));
      let c = codeAt(i32(x0) + dx, i32(y0) + dy);
      tb += w * (9407 * c.b - 2627 * c.r - 6780 * c.g);
      tr += w * (7373 * c.r - 6780 * c.g - 593 * c.b);
    }
  }
  let at = P.width * P.height / 2u + g.y * (P.width / 2u) + g.x;
  outWords[at] = (chroma(tb, 9623361) << 6u) | (chroma(tr, 7542579) << 22u);
}
`

const PARAMS = 48
const ALPHA = { premultiplied: 0, straight: 1, opaque: 2 } as const
const BINS = TOP + 2

/**
 * The HDR compositor for frames of one size on `device` (docs/adr/0023): what an `hdr10` render
 * composites with. Its SDR layers are decoded with the sRGB curve, taken to BT.2020 and placed at
 * `graphicsWhite`; its layers with `light` are taken as they declare. Each frame is measured from
 * its codes, and a frame past the mastering display's peak is an error, never clipped.
 */
export const hdrCompositor = (device: GPUDevice, width: number, height: number, hdr: Hdr10) => {
  const { peak } = hdr.mastering
  const stage = gpuStage(device, width, height)
  const { pixels, buffer, bind, pass } = stage
  const module = device.createShaderModule({ code: WGSL })
  const pipeline = (entryPoint: string) =>
    device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } })
  const pipelines = {
    init: pipeline('init'),
    layer: pipeline('layer'),
    encode: pipeline('encode'),
    meter: pipeline('meter'),
    p010: pipeline('p010'),
  }
  const STORAGE = GPUBufferUsage.STORAGE
  const COPY_SRC = GPUBufferUsage.COPY_SRC
  const READ = GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  const SIZE = { rgb10: pixels * 4, p010: pixels * 3 }
  const acc = buffer(pixels * 16, STORAGE)
  const nearest = buffer(pixels * 4, STORAGE)
  const codes = buffer(SIZE.rgb10, STORAGE | COPY_SRC)
  const histogram = buffer(BINS * 4, STORAGE | COPY_SRC | GPUBufferUsage.COPY_DST)
  const out = buffer(SIZE.p010, STORAGE | COPY_SRC)
  const read = buffer(SIZE.rgb10, READ)
  const readLevels = buffer(BINS * 4, READ)
  const top = peakCode(peak)
  const paramsOf = (
    i: number,
    o: { alpha: number; srgb: boolean; depth?: number; transfer: number; bt709: boolean },
    frame: number,
  ) => {
    const data = new ArrayBuffer(PARAMS)
    const u = new Uint32Array(data)
    const fl = new Float32Array(data)
    u.set([width, height, o.alpha, o.srgb ? 1 : 0, o.depth === undefined ? 0 : 1])
    fl[5] = o.depth ?? 0
    u.set([o.transfer, o.bt709 ? 1 : 0], 6)
    fl[8] = whiteOf(hdr) / PQ_PEAK
    u.set([hdr.dither === 'tpdf' ? 1 : 0, frame, top], 9)
    return stage.paramsAt(i, data)
  }

  /**
   * Composites `layers` bottom to top as frame `frame` (the dither's seed, and the frame an error
   * names), and reads back the output and the frame's light levels.
   */
  const composite = async (
    layers: readonly GpuLayer[],
    output: HdrOutput,
    frame: number,
  ): Promise<{ bytes: Uint8Array; light: LightLevels }> => {
    if (output === 'p010' && !p010Fits(width, height))
      throw new Error(`p010 needs an even width and height, not ${width}x${height}.`)
    const e = device.createCommandEncoder()
    const base = paramsOf(0, { alpha: 0, srgb: false, transfer: 0, bt709: false }, frame)
    e.clearBuffer(histogram)
    pass(
      e,
      pipelines.init,
      bind(pipelines.init, [
        [0, { buffer: acc }],
        [1, { buffer: nearest }],
        [2, { buffer: base }],
      ]),
      width,
      height,
    )
    for (const [i, layer] of layers.entries()) {
      const [texture, alpha] = stage.textureOf(layer, i)
      const depth = stage.depthOf(layer, i)
      const { light } = layer
      const p = paramsOf(
        i + 1,
        {
          alpha: ALPHA[alpha],
          srgb: texture.format.endsWith('-srgb'),
          depth: layer.depth ? (layer.depth.soft ?? 0) : undefined,
          transfer: light ? (light.transfer === 'linear' ? 1 : 2) : 0,
          bt709: (light?.primaries ?? 'bt709') === 'bt709',
        },
        frame,
      )
      pass(
        e,
        pipelines.layer,
        bind(pipelines.layer, [
          [0, { buffer: acc }],
          [1, { buffer: nearest }],
          [2, { buffer: p }],
          [3, texture.createView()],
          [4, { buffer: depth }],
        ]),
        width,
        height,
      )
    }
    pass(
      e,
      pipelines.encode,
      bind(pipelines.encode, [
        [0, { buffer: acc }],
        [2, { buffer: base }],
        [5, { buffer: codes }],
        [7, { buffer: histogram }],
      ]),
      width,
      height,
    )
    pass(
      e,
      pipelines.meter,
      bind(pipelines.meter, [
        [2, { buffer: base }],
        [5, { buffer: codes }],
        [7, { buffer: histogram }],
      ]),
      width,
      height,
      64,
    )
    if (output === 'p010')
      pass(
        e,
        pipelines.p010,
        bind(pipelines.p010, [
          [2, { buffer: base }],
          [5, { buffer: codes }],
          [6, { buffer: out }],
        ]),
        width / 2,
        height / 2,
      )
    e.copyBufferToBuffer(histogram, 0, readLevels, 0, BINS * 4)
    const target = output === 'p010' ? out : codes
    const [bytes] = await Promise.all([
      stage.readBack(e, target, read, SIZE[output]),
      readLevels.mapAsync(GPUMapMode.READ),
    ])
    let counts: Uint32Array
    try {
      counts = new Uint32Array(readLevels.getMappedRange().slice(0))
    } finally {
      readLevels.unmap()
    }
    if ((counts[TOP + 1] as number) > 0)
      throw new Error(
        `Frame ${frame} passes ${PQ_PEAK} cd/m², PQ's peak, in ${counts[TOP + 1]} pixels, above the mastering display's peak of ${peak} cd/m² (hdr10.mastering.peak). The engine never clips light: the film maps its own light down to the display it was graded on.`,
      )
    const light = levelsOf(counts, pixels)
    let brightest = TOP
    while (brightest > 0 && counts[brightest] === 0) brightest--
    if (brightest > top)
      throw new Error(
        `Frame ${frame} reaches ${Math.round(CODE_LIGHT[brightest] as number)} cd/m², above the mastering display's peak of ${peak} cd/m² (hdr10.mastering.peak). The engine never clips light: the film maps its own light down to the display it was graded on, or declares the display it was.`,
      )
    return { bytes, light }
  }

  const destroy = () => {
    for (const b of [acc, nearest, codes, histogram, out, read, readLevels]) b.destroy()
    stage.destroy()
  }
  return { width, height, composite, destroy }
}
export type HdrCompositor = ReturnType<typeof hdrCompositor>
