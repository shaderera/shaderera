// A CLI that opens a Node host on the project at argv[2], prints what the host's inspect gives and
// waits to be killed: what host.test.ts kills. With `disconnect`, it then closes its end of the
// host's IPC channel and lives on, as a parent killed on Linux or macOS looks to the host (on
// Windows, libuv's job object ends the host with its parent).
import type { ChildProcess } from 'node:child_process'
import { buildForNode } from '../build.ts'
import { openChild } from '../child.ts'
import { findProject } from '../project.ts'

const project = await findProject(process.argv[2] as string)
const child = await openChild(project, { entryFile: await buildForNode(project), params: {} })
console.log(JSON.stringify(await child.inspect(0)))
if (process.argv[3] === 'disconnect')
  for (const h of (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles())
    if (h && (h as object).constructor.name === 'ChildProcess') (h as ChildProcess).disconnect()
setInterval(() => {}, 1000)
