/*
 * The browser host: the project's runner page (runner/bridge.ts) in a headless Chrome of its own,
 * driven over the DevTools protocol, behind the same `Child` the Node host gives. The source runs
 * on the page's WebGPU, where Chrome compiles pipelines with DXC and keeps them in this project's
 * profile (.shaderera/chrome), and the project's DOM (manifest.dom) is laid out on the page and
 * drawn with HTML-in-Canvas. Chrome is the user's own install (CHROME overrides); none is bundled.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { Json, Range } from '@shaderera/core'
import type { TextRun } from '../review/measure.ts'
import { unpackClips } from '../runner/audio.ts'
import { type AdapterInfo, adapterLine, softwareAdapter } from './adapter.ts'
import { alive } from './build.ts'
import { CALL_TIMEOUT, type Child, callName, type Rendered, TIMEOUT } from './child.ts'
import type { Project } from './project.ts'
import { FRAME_PATH, frameUploads, RUNNER_PATH } from './runner-plugin.ts'
import { HOST, startRunner } from './runner-server.ts'
import type { BakeFrames } from './services.ts'

export const chromePath = () =>
  process.env.CHROME ??
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((p) => existsSync(p))

/** The flags that decide the browser host's GPU: doctor's probe starts Chrome with them too. */
const WEBGPU = ['--headless=new', '--enable-unsafe-webgpu']

/** The page's adapter, asked as the runner's worker asks for its own (runner/worker.ts). */
const ADAPTER = `(async () => {
  const info = (await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' }))?.info
  return info ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description, isFallbackAdapter: info.isFallbackAdapter } : null
})()`

/** Starts Chrome with `flags` (its profile among them) on about:blank. */
const startChrome = (chrome: string, flags: string[]) => {
  // Started from an elevated (administrator) process on Windows, Chrome starts itself again
  // de-elevated and exits: the Chrome left running is no child of ours, killing ours closes
  // nothing, and it keeps the profile's files open (#422). --do-not-de-elevate keeps it ours.
  const browser: ChildProcess = spawn(chrome, [...flags, '--do-not-de-elevate', 'about:blank'], {
    stdio: 'ignore',
  })
  const exited = new Promise<string>((done) =>
    browser.once('exit', (code, signal) => done(`it exited (${signal ?? code})`)),
  )
  return { browser, exited }
}

/** The DevTools socket of the page of the Chrome started on `profile`. */
const pageSocket = async (profile: string): Promise<string> => {
  // Chrome creates the file before it has written it, and on Windows may still hold it open
  // (EBUSY): read until its first line is a port.
  const portFile = join(profile, 'DevToolsActivePort')
  let devtools = ''
  for (let i = 0; i < 200 && !/^\d+$/.test(devtools); i++) {
    try {
      devtools = readFileSync(portFile, 'utf8').split('\n')[0] ?? ''
    } catch {}
    if (!/^\d+$/.test(devtools)) await sleep(100)
  }
  if (!/^\d+$/.test(devtools)) throw new Error('Chrome did not report its DevTools port.')
  const targets = (await (await fetch(`http://127.0.0.1:${devtools}/json`)).json()) as {
    type: string
    webSocketDebuggerUrl: string
  }[]
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('Chrome opened no page.')
  return page.webSocketDebuggerUrl
}

type Message = { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown }

/** One DevTools session over a WebSocket. */
export const session = async (
  url: string,
  closed: Promise<string>,
  timeout: { ms: number; expired: () => void },
) => {
  const ws = new WebSocket(url)
  await new Promise((done, fail) => {
    ws.onopen = done
    ws.onerror = fail
  })
  let next = 0
  const pending = new Map<number, (m: Message) => void>()
  const listeners = new Map<string, ((params: never) => void)[]>()
  // Chrome gone (it crashed, or was closed) fails every call waiting on it instead of hanging.
  let gone: Error | undefined
  const fail = (why: string) => {
    gone ??= new Error(`The browser host's Chrome closed: ${why}.`)
    for (const [id, answer] of pending) {
      pending.delete(id)
      answer({ error: gone.message })
    }
  }
  ws.onclose = () => fail('the DevTools connection closed')
  void closed.then(fail)
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data)) as Message
    if (m.id !== undefined) pending.get(m.id)?.(m)
    else if (m.method) for (const l of listeners.get(m.method) ?? []) l(m.params as never)
  }
  return {
    send: <T = unknown>(method: string, params: object = {}, sessionId?: string): Promise<T> =>
      new Promise((done, reject) => {
        if (gone) return reject(gone)
        const id = ++next
        // A hung page (a source that never returns) fails the call and closes Chrome, as the Node
        // host kills its child: the next call fails rather than waiting forever.
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`The browser host took longer than ${timeout.ms} ms on ${method}.`))
          // Gone from now on, not once the socket notices Chrome died (slow under load).
          fail(`a call took longer than ${timeout.ms} ms`)
          timeout.expired()
        }, timeout.ms)
        pending.set(id, (m) => {
          clearTimeout(timer)
          pending.delete(id)
          if (m.error)
            reject(
              new Error(
                typeof m.error === 'string' ? m.error : `${method}: ${JSON.stringify(m.error)}`,
              ),
            )
          else done(m.result as T)
        })
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      }),
    on: <P>(method: string, listener: (params: P) => void) => {
      listeners.set(method, [...(listeners.get(method) ?? []), listener as (p: never) => void])
    },
    close: () => ws.close(),
  }
}

/**
 * The adapter the browser host's Chrome gets (null: none), asked on an empty page in a throwaway
 * profile with the host's GPU flags: doctor's, which opens no project. The page is served on
 * localhost, since WebGPU needs a secure context and about:blank is not one.
 */
export const browserAdapter = async (chrome: string): Promise<AdapterInfo | null> => {
  const server = createServer((_, res) => res.end('<!doctype html>'))
  await new Promise<void>((done) => server.listen(0, HOST, done))
  const profile = mkdtempSync(join(tmpdir(), 'shaderera-gpu-'))
  const { browser, exited } = startChrome(chrome, [
    ...WEBGPU,
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
  ])
  try {
    const cdp = await session(await pageSocket(profile), exited, {
      ms: 30_000,
      expired: () => browser.kill(),
    })
    try {
      const evaluate = async <T>(expression: string) =>
        (
          await cdp.send<{ result: { value: T } }>('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
          })
        ).result.value
      await cdp.send('Page.navigate', {
        url: `http://${HOST}:${(server.address() as AddressInfo).port}/`,
      })
      for (let i = 0; !(await evaluate<boolean>('isSecureContext')); i++) {
        if (i > 100) throw new Error('Chrome did not load the probe page.')
        await sleep(100)
      }
      return await evaluate<AdapterInfo | null>(ADAPTER)
    } finally {
      cdp.close()
    }
  } finally {
    browser.kill()
    await exited
    server.close()
    // Windows: Chrome's helper processes hold files a moment after it exits; a throwaway left
    // behind is only disk.
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    } catch {}
  }
}

/**
 * Takes `lock` for this process: created only if absent (`wx`), so two hosts starting together
 * never both hold it; one left by a process that has exited is taken over.
 */
const takeLock = (lock: string, retry = true): boolean => {
  try {
    writeFileSync(lock, String(process.pid), { flag: 'wx' })
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  }
  let pid: number
  try {
    pid = Number(readFileSync(lock, 'utf8'))
  } catch {
    // Released meanwhile.
    return retry && takeLock(lock, false)
  }
  // An empty lock is one being written.
  if (!(pid > 0) || alive(pid)) return false
  rmSync(lock, { force: true })
  return retry && takeLock(lock, false)
}

/**
 * The Chrome profile for one browser host: the project's own (`.shaderera/chrome`, where Chrome
 * keeps its compiled pipelines), or, while another host holds that one, a throwaway one beside it.
 * Two Chromes on one profile become one: the second hands its page to the first.
 */
export const claimProfile = (root: string): { profile: string; release: () => void } => {
  const dir = join(root, '.shaderera')
  mkdirSync(dir, { recursive: true })
  const lock = join(dir, 'chrome.lock')
  if (takeLock(lock)) {
    const profile = join(dir, 'chrome')
    mkdirSync(profile, { recursive: true })
    const release = () => {
      // Only our own: a host that took over a lock it thought stale keeps it.
      try {
        if (readFileSync(lock, 'utf8') === String(process.pid)) rmSync(lock, { force: true })
      } catch {}
    }
    return { profile, release }
  }
  const profile = mkdtempSync(join(dir, 'chrome-'))
  const release = () => {
    // Windows: Chrome's helper processes hold files a moment after it exits. A throwaway left
    // behind is only disk; a failed cleanup must not fail (or hang) the work that used it.
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    } catch (error) {
      process.stderr.write(`Could not remove ${profile} (${String(error)}); delete it later.\n`)
    }
  }
  return { profile, release }
}

/** Opens the project in the browser host; the same calls as the Node host's child. */
export const openBrowserChild = async (
  project: Project,
  o: {
    params?: { [key: string]: Json }
    /** The source's `host.seed`; by default the manifest's, or 0. */
    seed?: number
    /** The source's `host.range`: `sdr` when absent. */
    range?: Range
    variant?: string
    /** A saved revision: its frozen entry and DOM (materialized under .shaderera/revisions/). */
    revision?: string
    /** Overrides the manifest's frame size (review's resized reopen). */
    size?: { width: number; height: number }
    timeoutMs?: number
    /**
     * How long each DevTools call may take while the host opens (the page loading, the source's
     * open); timeoutMs from then on. timeoutMs by default; a test of a hung call raises it, so a
     * page slow to open under load does not fail first.
     */
    openTimeoutMs?: number
    /** The bakes' frames, checked against their stamps: what io.bake reads. */
    bakes?: BakeFrames
    /** A draft render's: io.video's frames scaled by this much (createServices). */
    videoScale?: number
  } = {},
): Promise<Child> => {
  const chrome = chromePath()
  if (!chrome)
    throw new Error('No Chrome found for the browser host; set CHROME to its executable.')
  const pkgDir = fileURLToPath(new URL('../..', import.meta.url))
  const { profile, release } = claimProfile(project.root)
  // Vite's dependency cache lives in the claimed profile: two hosts optimising into one shared
  // folder at once fail (measured: EPERM on Windows).
  let started: Awaited<ReturnType<typeof startRunner>>
  try {
    started = await startRunner(project, {
      pkgDir,
      studioOrigins: ["'none'"],
      cacheDir: join(profile, 'vite'),
      ...(o.bakes ? { bakes: o.bakes } : {}),
      ...(o.videoScale ? { videoScale: o.videoScale } : {}),
    })
  } catch (error) {
    release()
    throw error
  }
  const { server: runner, port } = started
  rmSync(join(profile, 'DevToolsActivePort'), { force: true })
  const { width, height } = o.size ?? project.manifest
  const flags = [
    ...WEBGPU,
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--enable-features=CanvasDrawElement',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--mute-audio',
    // At least 1024×768: a smaller headless window draws a DOM as nothing (measured at 64×32);
    // the DOM's canvas is placed at the frame's size, whatever the window's.
    `--window-size=${Math.max(width, 1024)},${Math.max(height, 768)}`,
  ]
  const { browser, exited } = startChrome(chrome, flags)
  const close = async () => {
    browser.kill()
    await exited
    // The runner server closes whatever happens: left open, it keeps the process alive.
    try {
      release()
    } finally {
      await runner.close()
    }
  }
  try {
    const socket = await pageSocket(profile)
    const timeout = {
      ms: o.openTimeoutMs ?? o.timeoutMs ?? TIMEOUT,
      expired: () => browser.kill(),
    }
    const cdp = await session(socket, exited, timeout)
    await cdp.send('Runtime.enable')
    await cdp.send('Log.enable')
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    // The runner's worker, where the source runs: its console and exceptions come through too.
    cdp.on<{ sessionId: string; targetInfo: { type: string } }>('Target.attachedToTarget', (p) => {
      if (p.targetInfo.type === 'worker') void cdp.send('Runtime.enable', {}, p.sessionId)
    })
    await cdp.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    })
    cdp.on<{ entry: { level: string; text: string; url?: string } }>('Log.entryAdded', (p) => {
      if (p.entry.level === 'error') console.error(`page: ${p.entry.text} ${p.entry.url ?? ''}`)
    })
    cdp.on<{ exceptionDetails: { text: string; exception?: { description?: string } } }>(
      'Runtime.exceptionThrown',
      (p) =>
        console.error(
          `page: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`,
        ),
    )
    cdp.on<{ type: string; args: { value?: unknown; description?: string }[] }>(
      'Runtime.consoleAPICalled',
      (p) => {
        if (process.env.SHADERERA_PAGE_LOG || p.type === 'error' || p.type === 'warning')
          console.error(`page: ${p.args.map((a) => a.value ?? a.description).join(' ')}`)
      },
    )
    const evaluate = async <T>(expression: string): Promise<T> => {
      const r = await cdp.send<{
        result: { value?: T }
        exceptionDetails?: { exception?: { description?: string }; text: string }
      }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails)
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
      return r.result.value as T
    }
    const debug = (m: string) => process.env.SHADERERA_PAGE_LOG && console.error(`host: ${m}`)
    const pageReady = async () => {
      for (let i = 0; ; i++) {
        if (await evaluate<boolean>('typeof window.__shaderera !== "undefined"').catch(() => false))
          return
        if (i > 600) throw new Error('The runner page did not start.')
        await sleep(100)
      }
    }
    await cdp.send('Page.navigate', { url: `http://${HOST}:${port}${RUNNER_PATH}` })
    // Vite may reload the page once while it opens (it found dependencies to optimise): open again
    // on the reloaded page rather than fail.
    // The page's capabilities (runner/worker.ts Capabilities): the Child's and more.
    let opened: { capabilities: Child['has'] & { audio: boolean } } | undefined
    for (let attempt = 1; opened === undefined; attempt++) {
      await pageReady()
      debug('page ready, opening')
      try {
        // Raced against the worker failing to load (runner/bridge.ts), which answers no call.
        opened = await evaluate<NonNullable<typeof opened>>(
          `Promise.race([window.__shaderera.open(${JSON.stringify({ params: o.params, seed: o.seed, range: o.range, variant: o.variant, revision: o.revision, size: o.size })}), window.__shadereraFailed.then((m) => { throw new Error(m) })])`,
        )
      } catch (error) {
        if (
          attempt >= 3 ||
          !/navigated or closed|Execution context was destroyed/.test(String(error))
        )
          throw error
        debug(`the page reloaded while opening (${String(error)}); opening again`)
        await sleep(500)
      }
    }
    debug('opened')
    const { capabilities } = opened
    // Nothing in the page reports its work, so a call's allowance is for the whole call: the
    // open's for the first (it may compile its pipelines), for a sequential source (a call steps
    // every frame before t) and on a software adapter (10–100× slower); else a minute, or 10 times
    // the slowest call so far (several hosts sharing one GPU slow every frame).
    const software =
      o.timeoutMs === undefined &&
      (await evaluate<AdapterInfo | null>(ADAPTER).then((i) => !!i && !!softwareAdapter(i)))
    const long = software || !!capabilities.sequential
    let slowest = -1
    const allowance = () =>
      o.timeoutMs ?? (long || slowest < 0 ? TIMEOUT : Math.max(CALL_TIMEOUT, 10 * slowest))
    timeout.ms = allowance()
    // The Child's capabilities, as the Node host reports them; the page's own carry more.
    const has: Child['has'] = {
      inspect: capabilities.inspect,
      pick: capabilities.pick,
      camera: capabilities.camera,
      sequential: capabilities.sequential,
      yuv: capabilities.yuv,
      deep: capabilities.deep,
      p010: capabilities.p010,
    }
    // A call that took too long names what it was asked (`render at t = 1 s`) and --timeout.
    const call = async <T>(method: string, ...args: unknown[]): Promise<T> => {
      timeout.ms = allowance()
      const start = performance.now()
      try {
        const result = await evaluate<T>(
          `window.__shaderera.${method}(${args.map((a) => JSON.stringify(a)).join(',')})`,
        )
        slowest = Math.max(slowest, performance.now() - start)
        return result
      } catch (error) {
        if (!/^Error: The browser host took longer than/.test(String(error))) throw error
        const asked = callName({ type: method === 'send' ? 'render' : method, t: args[0] })
        throw new Error(
          `The browser host took longer than ${timeout.ms} ms on ${asked}: if it is working, --timeout <s> gives it longer.`,
        )
      }
    }
    return {
      render: async (t, intent, format = 'rgba') => {
        // The worker POSTs the frame to the runner server, which hands it here (decision 0007):
        // one HTTP body, not base64 over the DevTools protocol.
        const key = randomUUID()
        const arrived = new Promise<Buffer>((done) => frameUploads.set(key, done))
        let sent: Omit<Rendered, 'pixels'>
        try {
          sent = await call<Omit<Rendered, 'pixels'>>(
            'send',
            t,
            intent,
            format,
            `${FRAME_PATH}${key}`,
          )
        } finally {
          frameUploads.delete(key)
        }
        const bytes = await arrived
        return { pixels: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length), ...sent }
      },
      inspect: (t) => call('inspect', t),
      pick: (t, x, y) => call('pick', t, x, y),
      camera: (t) => call('camera', t),
      override: (m) => call('override', m),
      audio: async () => {
        // null without audio(), as in the Node host; the runner's own API gives [] (the web
        // player's callers expect a list).
        if (!capabilities.audio) return null
        // The worker POSTs the clips to the runner server as one body, samples as bytes
        // (runner/audio.ts): sound made in code for a long film is hundreds of MB, and a DevTools
        // message over 4 MiB closes the connection to Chrome (#353).
        const key = randomUUID()
        const arrived = new Promise<Buffer>((done) => frameUploads.set(key, done))
        try {
          await call('sendAudio', `${FRAME_PATH}${key}`)
        } finally {
          frameUploads.delete(key)
        }
        return unpackClips(await arrived)
      },
      captions: () => call('captions'),
      clock: () => call('clock'),
      profile: (reset) => call('profile', reset === true),
      fonts: async () => ({ fonts: [], failures: [] }),
      seeks: () => call('seeks'),
      text: async (t) => {
        const runs = await call<TextRun[]>('text', t)
        // Which fonts drew each run, fallbacks included: Chrome knows, the page does not.
        const { root } = await cdp.send<{ root: { nodeId: number } }>('DOM.getDocument', {
          depth: 0,
        })
        const { nodeIds } = await cdp.send<{ nodeIds: number[] }>('DOM.querySelectorAll', {
          nodeId: root.nodeId,
          selector: '[data-shaderera-run]',
        })
        for (const nodeId of nodeIds) {
          const { attributes } = await cdp.send<{ attributes: string[] }>('DOM.getAttributes', {
            nodeId,
          })
          const run = runs[Number(attributes[attributes.indexOf('data-shaderera-run') + 1])]
          const { fonts } = await cdp.send<{
            fonts: { familyName: string; isCustomFont: boolean; glyphCount: number }[]
          }>('CSS.getPlatformFontsForNode', { nodeId })
          if (run)
            run.rendered = fonts.map((f) => ({
              family: f.familyName,
              custom: f.isCustomFont,
              glyphs: f.glyphCount,
            }))
        }
        return runs
      },
      identity: async () => {
        const { product } = await cdp.send<{ product: string }>('Browser.getVersion')
        const info = await evaluate<AdapterInfo | null>(ADAPTER)
        const adapter = info ? adapterLine(info) : ''
        const software = info ? softwareAdapter(info) : undefined
        return {
          host: 'browser' as const,
          node: process.version,
          browser: product,
          flags: flags.filter((f) => /^--(enable|headless)/.test(f)),
          ...(adapter ? { adapter } : {}),
          ...(software ? { software } : {}),
        }
      },
      close: async () => {
        cdp.close()
        await close()
      },
      has,
      // For checks and diagnosis: an expression evaluated on the runner page.
      evaluate,
    } as Child
  } catch (error) {
    await close()
    throw error
  }
}
