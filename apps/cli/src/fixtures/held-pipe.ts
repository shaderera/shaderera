// A stand-in for ffmpeg whose pipe outlives it, as when another process inherited the pipe's end
// (spawn-turn.ts): before it exits it starts a process that holds its stdout and stderr for
// `hold` ms, so neither ends when it exits.
//   node held-pipe.ts out <frames> <bytes> <hold>   writes `frames` frames of `bytes`, then exits
//   node held-pipe.ts in <hold>                     reads stdin to its end, then exits
//   node held-pipe.ts deaf                          reads stdin and never exits on its end
import { spawn } from 'node:child_process'

const [mode, ...rest] = process.argv.slice(2)
const holdThenExit = (ms: number) => {
  spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], {
    stdio: ['ignore', 'inherit', 'inherit'],
    // Out of the job that ends a process's children with it (libuv, Windows).
    detached: true,
  }).unref()
  process.exit(0)
}
if (mode === 'out') {
  const [frames, bytes, hold] = rest.map(Number) as [number, number, number]
  process.stdout.write(Buffer.alloc(frames * bytes, 7), () => holdThenExit(hold))
} else if (mode === 'in') {
  process.stdin.resume()
  process.stdin.on('end', () => holdThenExit(Number(rest[0])))
} else {
  process.stdin.resume()
  setInterval(() => {}, 1000)
}
