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
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { Json, SampledClip } from '@shaderera/core'
import type { TextRun } from '../review/measure.ts'
import { alive } from './build.ts'
import { type Child, TIMEOUT } from './child.ts'
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

type Message = { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown }

/** One DevTools session over a WebSocket. */
const session = async (
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
 * The Chrome profile for one browser host: the project's own (`.shaderera/chrome`, where Chrome
 * keeps its compiled pipelines), or, while another host holds that one, a throwaway one beside it.
 * Two Chromes on one profile become one: the second hands its page to the first.
 */
const claimProfile = (root: string): { profile: string; release: () => void } => {
  const dir = join(root, '.shaderera')
  mkdirSync(dir, { recursive: true })
  const lock = join(dir, 'chrome.lock')
  const held = existsSync(lock) && alive(Number(readFileSync(lock, 'utf8')))
  if (!held) {
    writeFileSync(lock, String(process.pid))
    const profile = join(dir, 'chrome')
    mkdirSync(profile, { recursive: true })
    return { profile, release: () => rmSync(lock, { force: true }) }
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
    variant?: string
    /** A saved revision: its frozen entry and DOM (materialized under .shaderera/revisions/). */
    revision?: string
    /** Overrides the manifest's frame size (review's resized reopen). */
    size?: { width: number; height: number }
    timeoutMs?: number
    /** The bakes' frames, checked against their stamps: what io.bake reads. */
    bakes?: BakeFrames
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
    })
  } catch (error) {
    release()
    throw error
  }
  const { server: runner, port } = started
  rmSync(join(profile, 'DevToolsActivePort'), { force: true })
  const { width, height } = o.size ?? project.manifest
  const flags = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--enable-unsafe-webgpu',
    '--enable-features=CanvasDrawElement',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--mute-audio',
    // At least 1024×768: a smaller headless window draws a DOM as nothing (measured at 64×32);
    // the DOM's canvas is placed at the frame's size, whatever the window's.
    `--window-size=${Math.max(width, 1024)},${Math.max(height, 768)}`,
  ]
  const browser: ChildProcess = spawn(chrome, [...flags, 'about:blank'], { stdio: 'ignore' })
  const exited = new Promise<string>((done) =>
    browser.once('exit', (code, signal) => done(`it exited (${signal ?? code})`)),
  )
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
    const portFile = join(profile, 'DevToolsActivePort')
    for (let i = 0; i < 200 && !existsSync(portFile); i++) await sleep(100)
    const devtools = readFileSync(portFile, 'utf8').split('\n')[0]
    const targets = (await (await fetch(`http://127.0.0.1:${devtools}/json`)).json()) as {
      type: string
      webSocketDebuggerUrl: string
    }[]
    const page = targets.find((t) => t.type === 'page')
    if (!page) throw new Error('Chrome opened no page.')
    const cdp = await session(page.webSocketDebuggerUrl, exited, {
      ms: o.timeoutMs ?? TIMEOUT,
      expired: () => browser.kill(),
    })
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
    let opened: { capabilities: Child['has'] } | undefined
    for (let attempt = 1; opened === undefined; attempt++) {
      await pageReady()
      debug('page ready, opening')
      try {
        opened = await evaluate<{ capabilities: Child['has'] }>(
          `window.__shaderera.open(${JSON.stringify({ params: o.params, variant: o.variant, revision: o.revision, size: o.size })})`,
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
    const call = <T>(method: string, ...args: unknown[]) =>
      evaluate<T>(`window.__shaderera.${method}(${args.map((a) => JSON.stringify(a)).join(',')})`)
    return {
      render: async (t, intent, format = 'rgba') => {
        // The worker POSTs the frame to the runner server, which hands it here (decision 0007):
        // one HTTP body, not base64 over the DevTools protocol.
        const key = randomUUID()
        const arrived = new Promise<Buffer>((done) => frameUploads.set(key, done))
        try {
          await call('send', t, intent, format, `${FRAME_PATH}${key}`)
        } finally {
          frameUploads.delete(key)
        }
        const bytes = await arrived
        return { pixels: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length), layers: [] }
      },
      inspect: (t) => call('inspect', t),
      pick: (t, x, y) => call('pick', t, x, y),
      camera: (t) => call('camera', t),
      override: (m) => call('override', m),
      audio: async () => {
        // Sound made in code came as base64 float32 (worker.ts toBase64Pcm).
        const clips = await call<SampledClip[] | null>('audio')
        return (
          clips?.map((c) =>
            c.pcm
              ? {
                  ...c,
                  pcm: {
                    sampleRate: c.pcm.sampleRate,
                    channels: (c.pcm.channels as unknown as string[]).map((b64) => {
                      const bytes = Buffer.from(b64, 'base64')
                      return new Float32Array(
                        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
                      )
                    }),
                  },
                }
              : c,
          ) ?? null
        )
      },
      captions: () => call('captions'),
      clock: () => call('clock'),
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
        const adapter = await evaluate<string | null>(`(async () => {
          const info = (await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' }))?.info
          return info ? [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') : null
        })()`)
        return {
          host: 'browser' as const,
          node: process.version,
          browser: product,
          flags: flags.filter((f) => /^--(enable|headless)/.test(f)),
          ...(adapter ? { adapter } : {}),
        }
      },
      close: async () => {
        cdp.close()
        await close()
      },
      has: opened.capabilities,
      // For checks and diagnosis: an expression evaluated on the runner page.
      evaluate,
    } as Child
  } catch (error) {
    await close()
    throw error
  }
}
