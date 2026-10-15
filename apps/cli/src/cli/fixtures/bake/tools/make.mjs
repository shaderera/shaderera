// The bake: one byte a frame, the level plus the frame number, written outside the project.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const level = Number(readFileSync('level.txt', 'utf8'))
mkdirSync('../glow', { recursive: true })
for (let i = 0; i < 10; i++)
  writeFileSync(`../glow/glow.${String(i).padStart(3, '0')}.bin`, new Uint8Array([level + i]))
