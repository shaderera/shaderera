// A worker on its own clock: an interval, animation frames with Date, and a reply with the time.
const born = performance.now()
setInterval(() => postMessage({ kind: 'timer', x: Math.round(performance.now() - born) }), 50)
const frame = (t) => {
  postMessage({ kind: 'raf', x: Math.round(t), date: Date.now() - Date.UTC(2000, 0, 1) })
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
addEventListener('message', () => postMessage({ kind: 'reply', x: Math.round(performance.now()) }))
