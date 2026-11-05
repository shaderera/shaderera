// A worker that starts a worker and passes on what it posts.
const inner = new Worker('nested.js')
inner.onmessage = ({ data }) => postMessage(data)
