// A module worker: the time on a 100 ms timeout chain, rounded by what it imports.
import { whole } from './whole.js'

const tick = () => {
  postMessage(whole(performance.now()))
  setTimeout(tick, 100)
}
tick()
