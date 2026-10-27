//! io.image's decoder (ADR 0028): a PNG or JPEG file to straight RGBA, 8 bits a sample or 16 for a
//! 16-bit PNG, shrunk to `max_size` on its long side with one integer box filter. The same `.wasm`
//! runs in every host, so every host gets the same bytes.
//!
//! The interface is a plain C ABI, no bindings: `alloc` a buffer for the file, `decode` it, read
//! the result through the six words it points at. The caller drops the instance after each decode,
//! so nothing is ever freed here.

use zune_core::bit_depth::BitDepth;
use zune_core::bytestream::ZCursor;
use zune_core::colorspace::ColorSpace;
use zune_core::options::DecoderOptions;
use zune_core::result::DecodingResult;
use zune_jpeg::JpegDecoder;
use zune_png::PngDecoder;

/// RGBA samples, 4 a pixel, straight alpha.
#[derive(Debug, PartialEq)]
pub enum Samples {
    Eight(Vec<u8>),
    Sixteen(Vec<u16>),
}

/// A decoded still.
#[derive(Debug, PartialEq)]
pub struct Image {
    pub width: usize,
    pub height: usize,
    pub samples: Samples,
}

/// A buffer of `len` bytes for the file, in this instance's memory.
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len);
    let at = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    at
}

/// The six result words, kept: `[1, width, height, bits, data, data length]`, or `[0, 0, 0, 0,
/// message, message length]` for an error, the message UTF-8.
fn result(r: Result<(usize, usize, u32, Vec<u8>), String>) -> *const u32 {
    let (head, bytes) = match r {
        Ok((width, height, bits, data)) => ([1, width as u32, height as u32, bits], data),
        Err(message) => ([0; 4], message.into_bytes()),
    };
    let words = vec![head[0], head[1], head[2], head[3], bytes.as_ptr() as u32, bytes.len() as u32];
    std::mem::forget(bytes);
    let out = words.as_ptr();
    std::mem::forget(words);
    out
}

/// Decodes the `len` bytes at `at`. The words it points at (`result`) hold the RGBA bytes,
/// 16-bit samples little-endian. `max_size` 0 keeps the full size.
#[no_mangle]
pub extern "C" fn decode(at: *const u8, len: usize, max_size: u32) -> *const u32 {
    let file = unsafe { std::slice::from_raw_parts(at, len) };
    result(decode_file(file).map(|image| {
        let image = shrink(image, max_size as usize);
        let (bits, data) = match image.samples {
            Samples::Eight(v) => (8, v),
            Samples::Sixteen(v) => (16, v.iter().flat_map(|s| s.to_le_bytes()).collect()),
        };
        (image.width, image.height, bits, data)
    }))
}

/// The width, height and bits `decode` gives the `len` bytes at `at`, from the file's headers
/// alone (the cache's key, ADR 0028, 6). The words it points at (`result`) hold no data.
#[no_mangle]
pub extern "C" fn size(at: *const u8, len: usize, max_size: u32) -> *const u32 {
    let file = unsafe { std::slice::from_raw_parts(at, len) };
    result(file_size(file).map(|(width, height, bits)| {
        let (width, height) = shrunk_size(width, height, max_size as usize);
        (width, height, bits, Vec::new())
    }))
}

const PNG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG: [u8; 3] = [0xff, 0xd8, 0xff];

fn options() -> DecoderOptions {
    DecoderOptions::default()
        .set_max_width(1 << 16)
        .set_max_height(1 << 16)
        // Not png_set_add_alpha_channel: in zune-png 0.5.2 it leaves 1, 2 and 4-bit grey samples
        // packed. rgba adds the alpha itself.
        .png_set_strip_to_8bit(false)
        .jpeg_set_out_colorspace(ColorSpace::RGBA)
}

/// `samples` in `colour` widened to RGBA, `opaque` the alpha of a pixel that has none. A tRNS chunk
/// has already made Luma and RGB into LumaA and RGBA.
fn rgba<T: Copy>(samples: Vec<T>, colour: ColorSpace, opaque: T) -> Result<Vec<T>, String> {
    Ok(match colour {
        ColorSpace::RGBA => samples,
        ColorSpace::RGB => samples.chunks_exact(3).flat_map(|p| [p[0], p[1], p[2], opaque]).collect(),
        ColorSpace::LumaA => samples.chunks_exact(2).flat_map(|p| [p[0], p[0], p[0], p[1]]).collect(),
        ColorSpace::Luma => samples.iter().flat_map(|&v| [v, v, v, opaque]).collect(),
        other => return Err(format!("an unsupported PNG colour type ({other:?})")),
    })
}

/// A PNG or JPEG file's full width, height and bits as `decode_file` decodes it, from its headers.
pub fn file_size(file: &[u8]) -> Result<(usize, usize, u32), String> {
    if file.starts_with(&PNG) {
        let mut png = PngDecoder::new_with_options(ZCursor::new(file), options());
        png.decode_headers().map_err(|e| format!("{e:?}"))?;
        let (width, height) = png.dimensions().ok_or("no PNG header")?;
        return Ok((width, height, if png.depth() == Some(BitDepth::Sixteen) { 16 } else { 8 }));
    }
    if file.starts_with(&JPEG) {
        let mut jpeg = JpegDecoder::new_with_options(ZCursor::new(file), options());
        jpeg.decode_headers().map_err(|e| format!("{e:?}"))?;
        let info = jpeg.info().ok_or("no JPEG header")?;
        return Ok((usize::from(info.width), usize::from(info.height), 8));
    }
    Err("not a PNG or JPEG".into())
}

/// A PNG or JPEG file's pixels, at full size.
pub fn decode_file(file: &[u8]) -> Result<Image, String> {
    if file.starts_with(&PNG) {
        let mut png = PngDecoder::new_with_options(ZCursor::new(file), options());
        png.decode_headers().map_err(|e| format!("{e:?}"))?;
        let (width, height) = png.dimensions().ok_or("no PNG header")?;
        let colour = png.colorspace().ok_or("no PNG header")?;
        let samples = match png.decode().map_err(|e| format!("{e:?}"))? {
            DecodingResult::U8(v) => Samples::Eight(rgba(v, colour, u8::MAX)?),
            DecodingResult::U16(v) => Samples::Sixteen(rgba(v, colour, u16::MAX)?),
            _ => return Err("an unsupported PNG sample format".into()),
        };
        return Ok(Image { width, height, samples });
    }
    if file.starts_with(&JPEG) {
        let mut jpeg = JpegDecoder::new_with_options(ZCursor::new(file), options());
        let pixels = jpeg.decode().map_err(|e| format!("{e:?}"))?;
        let info = jpeg.info().ok_or("no JPEG header")?;
        let (width, height) = (usize::from(info.width), usize::from(info.height));
        if pixels.len() != width * height * 4 {
            return Err("a JPEG that did not decode to RGBA".into());
        }
        return Ok(Image { width, height, samples: Samples::Eight(pixels) });
    }
    Err("not a PNG or JPEG".into())
}

/// `n / q` rounded half up.
fn round_div(n: u64, q: u64) -> u64 {
    (2 * n + q) / (2 * q)
}

/// The size `max_size` gives: the long side exactly `max_size`, the short side rounded, the aspect
/// kept. A still already within it keeps its size.
pub fn shrunk_size(width: usize, height: usize, max_size: usize) -> (usize, usize) {
    let long = width.max(height);
    if max_size == 0 || long <= max_size {
        return (width, height);
    }
    let short = |side: usize| (round_div((side * max_size) as u64, long as u64) as usize).max(1);
    if width >= height { (max_size, short(height)) } else { (short(width), max_size) }
}

/// For each of `m` output pixels along a line of `n`, the source pixels under it and the length
/// each covers, in units of 1/(n × m) of the line, so every weight is a whole number and they sum
/// to `n`.
fn spans(n: usize, m: usize) -> Vec<(usize, Vec<u64>)> {
    (0..m)
        .map(|x| {
            let (from, to) = (x * n, (x + 1) * n);
            let first = from / m;
            let weights = (first..to.div_ceil(m)).map(|i| (((i + 1) * m).min(to) - (i * m).max(from)) as u64).collect();
            (first, weights)
        })
        .collect()
}

/// Weighted sums of pixels: colour weighted by alpha, and alpha.
#[derive(Clone, Copy, Default)]
struct Sum {
    colour: [u64; 3],
    alpha: u64,
}

impl Sum {
    fn add(&mut self, weight: u64, p: [u64; 4]) {
        let w = weight * p[3];
        self.alpha += w;
        self.colour[0] += w * p[0];
        self.colour[1] += w * p[1];
        self.colour[2] += w * p[2];
    }
    /// Straight again, each sample rounded half up once; where the alpha sum is 0, the colour is 0.
    /// `n` is the sum of the weights.
    fn pixel(&self, n: u64) -> [u32; 4] {
        let straight = |c: u64| if self.alpha == 0 { 0 } else { round_div(c, self.alpha) as u32 };
        [straight(self.colour[0]), straight(self.colour[1]), straight(self.colour[2]), round_div(self.alpha, n) as u32]
    }
}

/// `src`'s `w × h` pixels shrunk to `nw × nh` with the box filter: rows, then columns, each pass
/// rounding once. The column pass adds whole rows, so memory is read in order.
fn shrink_samples<T: Copy + Into<u64>>(src: &[T], w: usize, h: usize, nw: usize, nh: usize) -> Vec<[u32; 4]> {
    let across = spans(w, nw);
    let mut rows = Vec::with_capacity(h * nw);
    for row in src.chunks_exact(w * 4) {
        for (first, weights) in &across {
            let mut sum = Sum::default();
            for (k, &weight) in weights.iter().enumerate() {
                let p = &row[(first + k) * 4..(first + k) * 4 + 4];
                sum.add(weight, [p[0].into(), p[1].into(), p[2].into(), p[3].into()]);
            }
            rows.push(sum.pixel(w as u64));
        }
    }
    let mut out = Vec::with_capacity(nw * nh);
    for (first, weights) in spans(h, nh) {
        let mut sums = vec![Sum::default(); nw];
        for (k, &weight) in weights.iter().enumerate() {
            let row = &rows[(first + k) * nw..(first + k + 1) * nw];
            for (sum, p) in sums.iter_mut().zip(row) {
                sum.add(weight, p.map(u64::from));
            }
        }
        out.extend(sums.iter().map(|s| s.pixel(h as u64)));
    }
    out
}

/// The still shrunk to `max_size` (shrunk_size) with the box filter.
pub fn shrink(image: Image, max_size: usize) -> Image {
    let (nw, nh) = shrunk_size(image.width, image.height, max_size);
    if (nw, nh) == (image.width, image.height) {
        return image;
    }
    let (w, h) = (image.width, image.height);
    let samples = match &image.samples {
        Samples::Eight(v) => Samples::Eight(shrink_samples(v, w, h, nw, nh).iter().flatten().map(|&s| s as u8).collect()),
        Samples::Sixteen(v) => {
            Samples::Sixteen(shrink_samples(v, w, h, nw, nh).iter().flatten().map(|&s| s as u16).collect())
        }
    };
    Image { width: nw, height: nh, samples }
}
