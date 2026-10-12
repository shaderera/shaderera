// A source that breaks the rule: its picture counts the frames rendered before it. It also logs.
export default () => {
  let calls = 0
  return {
    async render(t: number) {
      console.log(`rendering ${t}`)
      calls += 1
      return { color: new Uint8Array(64 * 36 * 4).fill(calls), alpha: 'opaque' as const }
    },
  }
}
