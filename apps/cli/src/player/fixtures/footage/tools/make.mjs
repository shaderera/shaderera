// The bake: one byte a frame, 100 plus the frame number.
import { mkdirSync, writeFileSync } from 'node:fs'

mkdirSync('out/level', { recursive: true })
for (let i = 0; i < 3; i++) writeFileSync(`out/level/level.${i}.bin`, new Uint8Array([100 + i]))
