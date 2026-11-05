// A worker started by a worker: the time on a 50 ms interval and on each animation frame.
setInterval(() => postMessage({ kind: 'interval', x: Math.round(performance.now()) }), 50)
const frame = (t) => {
  postMessage({ kind: 'frame', x: Math.round(t) })
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
