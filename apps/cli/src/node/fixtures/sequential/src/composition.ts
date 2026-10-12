// A source that can only step forward: its picture is the number of frames it has rendered.
export default () => {
  let frames = 0
  let last = -1
  return {
    async render(t: number) {
      if (t < last) throw new Error('stepped backwards')
      last = t
      frames += 1
      return { color: new Uint8Array(4 * 2 * 4).fill(frames * 10), alpha: 'opaque' }
    },
    async inspect(t: number) {
      return { t, frames }
    },
  }
}
