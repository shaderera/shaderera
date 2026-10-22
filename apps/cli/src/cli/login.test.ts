import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { tempDir } from '../fixtures/temp.ts'
import { type LoginDeps, machineName, run } from './login.ts'
import { run as logout } from './logout.ts'
import { saveToken } from './site.ts'
import { run as whoami } from './whoami.ts'

// Tokens are kept under the home directory: this file's own, never the person's.
const home = tempDir('login-home')
process.env.HOME = home
process.env.USERPROFILE = home
delete process.env.SHADERERA_API
const tokensFile = join(home, '.shaderera', 'tokens.json')

const GITHUB_TOKEN = 'gho_github-secret'
const API_TOKEN = 'sha_api-secret'
const EXPIRES = Date.UTC(2027, 0, 19)

const listen = async (
  handle: (
    req: { method: string; path: string; auth?: string; body: string },
    res: ServerResponse,
  ) => void,
) => {
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = []
    for await (const p of req) parts.push(p as Buffer)
    handle(
      {
        method: req.method ?? '',
        path: req.url ?? '',
        ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
        body: Buffer.concat(parts).toString(),
      },
      res,
    )
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  after(() => server.close())
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
const json = (res: ServerResponse, status: number, body?: unknown) => {
  res.writeHead(status, body === undefined ? {} : { 'Content-Type': 'application/json' })
  res.end(body === undefined ? undefined : JSON.stringify(body))
}

/**
 * GitHub's device flow endpoints: the device code, then `polls` answered in turn (each an error
 * code, or "token"). It records every form it was sent.
 */
const github = {
  device: { interval: 5, expires_in: 900 } as Record<string, unknown>,
  polls: [] as string[],
  forms: [] as { path: string; form: Record<string, string> }[],
}
const githubOrigin = await listen(({ path, body }, res) => {
  const form = Object.fromEntries(new URLSearchParams(body))
  github.forms.push({ path, form })
  if (path === '/login/device/code')
    return json(res, 200, {
      device_code: 'dev-123',
      user_code: 'WDJB-MJHT',
      verification_uri: 'https://github.com/login/device',
      ...github.device,
    })
  const next = github.polls.shift() ?? 'authorization_pending'
  if (next === 'token')
    return json(res, 200, { access_token: GITHUB_TOKEN, token_type: 'bearer', scope: '' })
  json(res, 200, { error: next, ...(next === 'slow_down' ? { interval: 10 } : {}) })
})

/**
 * The films API's auth routes (shaderera.com API.md): a GitHub token and a machine's name for a
 * Shaderera token; whose a token is; signing out. Its 401s name no command, as the API's do.
 */
const api = {
  signIns: [] as unknown[],
  logouts: [] as unknown[],
  live: new Set<string>(),
  setUp: true,
}
const apiOrigin = await listen(({ method, path, auth, body }, res) => {
  const token = auth?.replace(/^Bearer /, '')
  if (method === 'POST' && path === '/api/v1/auth/github') {
    if (!api.setUp) return json(res, 503, { error: 'Sign-in is not set up on this server.' })
    const b = JSON.parse(body) as { token?: string; name?: string }
    api.signIns.push(b)
    if (b.token !== GITHUB_TOKEN) return json(res, 401, { error: 'GitHub refused the token.' })
    if (!b.name) return json(res, 400, { error: 'name is not a machine name.' })
    api.live.add(API_TOKEN)
    return json(res, 200, { token: API_TOKEN, handle: 'ana', name: b.name, expiresAt: EXPIRES })
  }
  if (!token || !api.live.has(token)) return json(res, 401, { error: 'A valid token is needed.' })
  if (method === 'GET' && path === '/api/v1/auth/me')
    return json(res, 200, { handle: 'ana', name: 'studio-mac', expiresAt: EXPIRES })
  if (method === 'POST' && path === '/api/v1/auth/logout') {
    api.logouts.push(body ? JSON.parse(body) : null)
    api.live.delete(token)
    return json(res, 204)
  }
  json(res, 404, { error: 'Not found.' })
})

let slept: number[] = []
let opened: string[] = []
const deps = (o: Partial<LoginDeps> = {}): LoginDeps => ({
  github: {
    deviceCode: `${githubOrigin}/login/device/code`,
    accessToken: `${githubOrigin}/login/oauth/access_token`,
  },
  clientId: '',
  open: (url) => opened.push(url),
  sleep: async (s) => {
    slept.push(s)
  },
  machine: () => 'studio-mac',
  ...o,
})

/** Runs a command in this process, with what it printed. */
const capture = async (go: () => Promise<number>) => {
  const out: string[] = []
  const log = console.log
  console.log = (...parts: unknown[]) => out.push(parts.map(String).join(' '))
  try {
    const status = await go()
    return { status, out: out.join('\n') }
  } catch (e) {
    return { status: 2, out: out.join('\n'), error: (e as Error).message }
  } finally {
    console.log = log
  }
}
const login = (args: string[], d = deps()) => capture(() => run(args, d))
const stored = () =>
  existsSync(tokensFile) ? JSON.parse(readFileSync(tokensFile, 'utf8')) : undefined

beforeEach(() => {
  process.env.SHADERERA_GITHUB_CLIENT_ID = 'Iv1.test-client'
  github.device = { interval: 5, expires_in: 900 }
  github.polls = []
  github.forms = []
  api.signIns.length = 0
  api.logouts.length = 0
  api.setUp = true
  slept = []
  opened = []
})

test("login signs in with GitHub: waits, slows down, then keeps this machine's token", async () => {
  github.polls = ['authorization_pending', 'slow_down', 'token']
  const r = await login(['--api', apiOrigin, '--no-open'])
  assert.equal(r.status, 0, r.error)
  assert.match(r.out, /Enter the code WDJB-MJHT at https:\/\/github\.com\/login\/device/)
  assert.match(
    r.out,
    new RegExp(`Signed in as ana on ${apiOrigin}: this machine as "studio-mac", until 2027-01-19`),
  )
  assert.deepEqual(opened, [])
  // GitHub's interval, then 10 s after slow_down.
  assert.deepEqual(slept, [5, 5, 10])
  assert.deepEqual(github.forms[0], {
    path: '/login/device/code',
    form: { client_id: 'Iv1.test-client' },
  })
  assert.deepEqual(github.forms.at(-1)?.form, {
    client_id: 'Iv1.test-client',
    device_code: 'dev-123',
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  })
  // The GitHub token goes to the API once, with the machine's name; the API's token is kept, and
  // neither is printed.
  assert.deepEqual(api.signIns, [{ token: GITHUB_TOKEN, name: 'studio-mac' }])
  assert.equal(stored()[apiOrigin], API_TOKEN)
  assert.doesNotMatch(r.out, /secret/)
  assert.doesNotMatch(readFileSync(tokensFile, 'utf8'), /gho_/)
})

test('login opens the page unless --no-open', async () => {
  github.polls = ['token']
  const r = await login(['--api', apiOrigin])
  assert.equal(r.status, 0, r.error)
  assert.deepEqual(opened, ['https://github.com/login/device'])
})

test('login stops when the code expires, or when GitHub says it did', async () => {
  github.polls = ['authorization_pending', 'expired_token']
  const r = await login(['--api', apiOrigin, '--no-open'])
  assert.match(r.error ?? '', /expired/)
  github.device = { interval: 5, expires_in: 10 }
  github.polls = []
  const local = await login(['--api', apiOrigin, '--no-open'])
  assert.match(local.error ?? '', /expired/)
  assert.deepEqual(slept.slice(2), [5, 5])
  assert.deepEqual(api.signIns, [])
})

test('login stops when the person declines on GitHub, and keeps nothing', async () => {
  const before = stored()
  github.polls = ['access_denied']
  const r = await login(['--api', 'http://127.0.0.1:1', '--no-open'])
  assert.match(r.error ?? '', /declined/)
  assert.deepEqual(api.signIns, [])
  assert.deepEqual(stored(), before)
})

test('a GitHub token the API refuses is not kept, and the error says once how to sign in', async () => {
  const refusing = await listen((_, res) => json(res, 401, { error: 'GitHub refused the token.' }))
  github.polls = ['token']
  const r = await login(['--api', refusing, '--no-open'])
  assert.match(
    r.error ?? '',
    new RegExp(`401 GitHub refused the token\\. Sign in: npx shaderera login --api ${refusing}$`),
  )
  assert.doesNotMatch(r.error ?? '', /gho_/)
  assert.equal(stored()?.[refusing], undefined)
})

test('an API without GitHub sign-in set up (503) says to use --token', async () => {
  api.setUp = false
  github.polls = ['token']
  const r = await login(['--api', apiOrigin, '--no-open'])
  assert.equal(
    r.error,
    `${apiOrigin} has no GitHub sign-in set up yet: use shaderera login --token <token> --api ${apiOrigin}.`,
  )
})

test('without a client id, login says it is not set up and to use --token; --token still works', async () => {
  delete process.env.SHADERERA_GITHUB_CLIENT_ID
  const r = await login(['--api', apiOrigin])
  assert.match(r.error ?? '', /GitHub sign-in isn't set up in this shaderera yet .*--token/)
  assert.equal(github.forms.length, 0)
  // The built-in id is used when the environment gives none.
  github.polls = ['token']
  assert.equal(
    (await login(['--api', apiOrigin, '--no-open'], deps({ clientId: 'Iv1.built-in' }))).status,
    0,
  )
  assert.equal(github.forms[0]?.form.client_id, 'Iv1.built-in')
  const t = await login(['--token', 'tok-by-hand', '--api', 'https://by-hand.example'])
  assert.equal(t.status, 0)
  assert.doesNotMatch(t.out, /tok-by-hand/)
  assert.equal(stored()['https://by-hand.example'], 'tok-by-hand')
})

test("a machine's name: the host name the API takes, else 'this machine'", () => {
  assert.equal(machineName('studio-mac'), 'studio-mac')
  assert.equal(machineName(' ana\u0007s box '), 'anas box')
  assert.equal(machineName('x'.repeat(80)), 'x'.repeat(64))
  assert.equal(machineName(''), 'this machine')
})

test('whoami says who this machine is signed in as; logout signs it out and forgets the token', async () => {
  github.polls = ['token']
  assert.equal((await login(['--api', apiOrigin, '--no-open'])).status, 0)
  const me = await capture(() => whoami(['--api', apiOrigin]))
  assert.equal(me.status, 0, me.error)
  assert.equal(me.out, `ana on ${apiOrigin}: this machine as "studio-mac", until 2027-01-19`)
  const asJson = await capture(() => whoami(['--api', apiOrigin, '--json']))
  assert.deepEqual(JSON.parse(asJson.out), {
    api: apiOrigin,
    signedIn: true,
    handle: 'ana',
    name: 'studio-mac',
    expiresAt: EXPIRES,
  })

  const out = await capture(() => logout(['--api', apiOrigin]))
  assert.equal(out.status, 0, out.error)
  assert.equal(out.out, `Signed out of ${apiOrigin}.`)
  assert.deepEqual(api.logouts, [null])
  assert.equal(stored()[apiOrigin], undefined)
  assert.ok(!api.live.has(API_TOKEN), 'the API no longer takes it')

  // Signed out: whoami says how to sign in and exits 1; a second logout is no error.
  const none = await capture(() => whoami(['--api', apiOrigin]))
  assert.equal(none.status, 1)
  assert.equal(
    none.out,
    `Not signed in to ${apiOrigin}. Sign in: npx shaderera login --api ${apiOrigin}`,
  )
  assert.equal(
    (await capture(() => logout(['--api', apiOrigin]))).out,
    `Not signed in to ${apiOrigin}.`,
  )
})

test('logout --all signs out every machine; a token the API no longer takes is forgotten too', async () => {
  github.polls = ['token']
  await login(['--api', apiOrigin, '--no-open'])
  const all = await capture(() => logout(['--api', apiOrigin, '--all']))
  assert.equal(all.out, `Signed out of ${apiOrigin} on every machine.`)
  assert.deepEqual(api.logouts, [{ all: true }])

  // A token signed out elsewhere: whoami says so, and logout forgets it (the API's 401 is done).
  saveToken(apiOrigin, 'sha_gone')
  const stale = await capture(() => whoami(['--api', apiOrigin]))
  assert.equal(stale.status, 1)
  assert.match(stale.out, /The token here is no longer signed in to .*Sign in: npx shaderera login/)
  const out = await capture(() => logout(['--api', apiOrigin]))
  assert.equal(out.status, 0, out.error)
  assert.equal(stored()[apiOrigin], undefined)

  // An API that cannot be reached: the token is kept, to be signed out later.
  saveToken('http://127.0.0.1:1', 'sha_kept')
  const down = await capture(() => logout(['--api', 'http://127.0.0.1:1']))
  assert.equal(down.status, 2)
  assert.match(down.error ?? '', /cannot be reached/)
  assert.equal(stored()['http://127.0.0.1:1'], 'sha_kept')
})
