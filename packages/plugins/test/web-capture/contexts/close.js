// A worker that posts its time once and then ends itself.
postMessage(Math.round(performance.now()))
setTimeout(() => self.close(), 20)
