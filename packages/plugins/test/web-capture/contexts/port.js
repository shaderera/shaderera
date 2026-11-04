// A worker that answers on the MessagePort it is sent, with its time.
addEventListener('message', ({ ports }) => ports[0]?.postMessage(Math.round(performance.now())))
