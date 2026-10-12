#!/usr/bin/env node
// In the workspace the CLI runs from source (Node strips the types); a published package runs dist.
import { existsSync } from 'node:fs'

const source = new URL('../src/cli/main.ts', import.meta.url)
await import(
  existsSync(source) ? source.href : new URL('../dist/cli/main.js', import.meta.url).href
)
