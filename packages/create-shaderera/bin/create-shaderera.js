#!/usr/bin/env node
// In the workspace it runs from source (Node strips the types); a published package runs dist.
import { existsSync } from 'node:fs'

const source = new URL('../src/index.ts', import.meta.url)
await import(existsSync(source) ? source.href : new URL('../dist/index.js', import.meta.url).href)
