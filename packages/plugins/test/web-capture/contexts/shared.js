// A shared worker, which no clock holds.
addEventListener('connect', ({ ports }) => ports[0]?.postMessage(performance.now()))
