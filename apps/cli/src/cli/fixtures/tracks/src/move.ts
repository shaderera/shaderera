/** Where an element is at t: a smoothstep from x 0 to 40 over 0.5 s from `start`. */
export const at = (t: number, start: number): number => {
  const p = Math.min(1, Math.max(0, (t - start) / 0.5))
  return 40 * p * p * (3 - 2 * p)
}
/** The card starts 2 frames (0.2 s at 10 fps) after the reference's 0.6 s; the dot on it. */
export const CARD = 0.8
export const DOT = 0.6
