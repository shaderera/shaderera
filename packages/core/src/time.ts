/** Every frame time in [from, to), each computed from its integer index so it never drifts. */
export const frameTimes = (fps: number, from: number, to: number): number[] => {
  const eps = 1e-9
  const times: number[] = []
  for (let i = Math.max(0, Math.ceil(from * fps - eps)); i / fps < to - eps; i++)
    times.push(i / fps)
  return times
}

/** The number of frames in [0, duration). */
export const frameCount = (fps: number, duration: number): number =>
  frameTimes(fps, 0, duration).length

/** The frame index of t: the nearest frame, so t = i / fps gives back i however it was computed. */
export const frameAt = (t: number, fps: number): number => Math.round(t * fps)

/** The NTSC rates: n × 1000/1001 for these nominal n (23.976, 29.97, 47.952, 59.94, 119.88). */
const NTSC = [24, 30, 48, 60, 120]

/**
 * A frame rate as written in shaderera.json, exactly: a number, or a fraction `"24000/1001"`. An
 * NTSC rate written as a decimal (23.976, 29.97, 59.94) is that fraction, since the decimal is
 * only its label. Null for anything that is not a positive rate.
 */
export const parseFps = (value: unknown): { fps: number; num: number; den: number } | null => {
  let num: number
  let den: number
  if (typeof value === 'string') {
    const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(value)
    if (!m) return null
    num = Number(m[1])
    den = Number(m[2])
  } else if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ntsc = NTSC.find((n) => Math.abs(value - (n * 1000) / 1001) < 0.005)
    if (ntsc !== undefined) [num, den] = [ntsc * 1000, 1001]
    else if (Number.isInteger(value)) [num, den] = [value, 1]
    else [num, den] = [Math.round(value * 1000), 1000]
  } else return null
  if (!(num > 0 && den > 0)) return null
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
  const g = gcd(num, den)
  return { fps: num / g / (den / g), num: num / g, den: den / g }
}

/** A rate as ffmpeg and a player take it: `30`, or `24000/1001` for an NTSC rate. */
export const fpsFraction = (fps: number): string => {
  const r = parseFps(fps)
  return r && r.den !== 1 ? `${r.num}/${r.den}` : String(fps)
}

/** Whether a rate counts timecode drop-frame (29.97 and 59.94; SMPTE 12M). */
export const dropFrame = (fps: number): boolean => {
  const r = parseFps(fps)
  return !!r && r.den === 1001 && (r.num === 30000 || r.num === 60000)
}

/**
 * A frame index as SMPTE timecode at the rate's nominal whole frame count: `HH:MM:SS:FF`, or
 * `HH:MM:SS;FF` drop-frame at 29.97 and 59.94, which skips frame numbers 0 and 1 (0 to 3 at 59.94)
 * at the start of every minute but each tenth, so the timecode keeps to the clock.
 */
export const timecodeOf = (frame: number, fps: number): string => {
  const nominal = Math.round(fps)
  let f = Math.round(frame)
  const drop = dropFrame(fps)
  if (drop) {
    const skip = nominal === 60 ? 4 : 2
    const perTen = nominal * 600 - skip * 9
    const perMinute = nominal * 60 - skip
    const tens = Math.floor(f / perTen)
    const rest = f % perTen
    f += skip * 9 * tens + (rest > skip ? skip * Math.floor((rest - skip) / perMinute) : 0)
  }
  const pad = (n: number) => String(n).padStart(2, '0')
  const s = Math.floor(f / nominal)
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}${drop ? ';' : ':'}${pad(f % nominal)}`
}

/** A timecode (timecodeOf's form, `;` for drop-frame) back to its frame index at this rate. */
export const framesOfTimecode = (timecode: string, fps: number): number => {
  const m = /^(\d\d):(\d\d):(\d\d)[:;](\d\d)$/.exec(timecode)
  if (!m) throw new Error(`Not a timecode: ${timecode} (HH:MM:SS:FF)`)
  const [h, min, s, f] = m.slice(1).map(Number) as [number, number, number, number]
  const nominal = Math.round(fps)
  let frames = ((h * 60 + min) * 60 + s) * nominal + f
  if (dropFrame(fps)) {
    const skip = nominal === 60 ? 4 : 2
    const minutes = h * 60 + min
    frames -= skip * (minutes - Math.floor(minutes / 10))
  }
  return frames
}
