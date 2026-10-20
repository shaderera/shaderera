import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { type LoginDeps, run } from './login.ts'

// Tokens are kept under the home directory: this file's own, never the person's.
const home = mkdtempSync(join(tmpdir(), 'shaderera-login-home-'))
process.env.HOME = home
process.env.USERPROFILE = home
delete process.env.SHADERERA_SITE
const tokensFile = join(home, '.shaderera', 'tokens.json')

const GITHUB_TOKEN = 'gho_github-secret'
const SITE_TOKEN = 'sha_site-secret'

const listen = async (handle: (path: string, body: string, res: ServerResponse) => void) => {
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = []
    for await (const p of req) parts.push(p as Buffer)
    handle(req.url ?? '', Buffer.concat(parts).toString(), res)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  after(() => server.close())
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
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
const githubOrigin = await listen((path, body, res) => {
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

/** The films app's sign-in: GitHub's token for a Shaderera one. */
const signIns: unknown[] = []
const site = await listen((path, body, res) => {
  if (path !== '/api/v1/auth/github') return json(res, 404, { error: 'Not found.' })
  const b = JSON.parse(body) as { token?: string }
  signIns.push(b)
  if (b.token !== GITHUB_TOKEN)
    return json(res, 401, { error: 'GitHub refused the token. Sign in again: npx shaderera login' })
  json(res, 200, { token: SITE_TOKEN, handle: 'ana' })
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
  ...o,
})

/** Runs `shaderera login` in this process, with what it printed. */
const login = async (args: string[], d = deps()) => {
  const out: string[] = []
  const log = console.log
  console.log = (...parts: unknown[]) => out.push(parts.map(String).join(' '))
  try {
    const status = await run(args, d)
    return { status, out: out.join('\n') }
  } catch (e) {
    return { status: 1, out: out.join('\n'), error: (e as Error).message }
  } finally {
    console.log = log
  }
}
const stored = () =>
  existsSync(tokensFile) ? JSON.parse(readFileSync(tokensFile, 'utf8')) : undefined

beforeEach(() => {
  process.env.SHADERERA_GITHUB_CLIENT_ID = 'Iv1.test-client'
  github.device = { interval: 5, expires_in: 900 }
  github.polls = []
  github.forms = []
  signIns.length = 0
  slept = []
  opened = []
})

test('login signs in with GitHub: waits, slows down, then keeps the site’s token', async () => {
  github.polls = ['authorization_pending', 'slow_down', 'token']
  const r = await login(['--to', site, '--no-open'])
  assert.equal(r.status, 0, r.error)
  assert.match(r.out, /Enter the code WDJB-MJHT at https:\/\/github\.com\/login\/device/)
  assert.match(r.out, /Signed in as ana/)
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
  // The GitHub token goes to the site once; the site's token is kept, and neither is printed.
  assert.deepEqual(signIns, [{ token: GITHUB_TOKEN }])
  assert.equal(stored()[site], SITE_TOKEN)
  assert.doesNotMatch(r.out, /secret/)
  assert.doesNotMatch(readFileSync(tokensFile, 'utf8'), /gho_/)
})

test('login opens the page unless --no-open', async () => {
  github.polls = ['token']
  const r = await login(['--to', site])
  assert.equal(r.status, 0, r.error)
  assert.deepEqual(opened, ['https://github.com/login/device'])
})

test('login stops when the code expires, or when GitHub says it did', async () => {
  github.polls = ['authorization_pending', 'expired_token']
  const r = await login(['--to', site, '--no-open'])
  assert.match(r.error ?? '', /expired/)
  github.device = { interval: 5, expires_in: 10 }
  github.polls = []
  const local = await login(['--to', site, '--no-open'])
  assert.match(local.error ?? '', /expired/)
  assert.deepEqual(slept.slice(2), [5, 5])
  assert.deepEqual(signIns, [])
})

test('login stops when the person declines on GitHub, and keeps nothing', async () => {
  const before = stored()
  github.polls = ['access_denied']
  const r = await login(['--to', 'http://127.0.0.1:1', '--no-open'])
  assert.match(r.error ?? '', /declined/)
  assert.deepEqual(signIns, [])
  assert.deepEqual(stored(), before)
})

test('a GitHub token the site refuses is not kept, and the error says how to sign in', async () => {
  const refusing = await listen((_, __, res) =>
    json(res, 401, { error: 'GitHub refused the token. Sign in again: npx shaderera login' }),
  )
  github.polls = ['token']
  const r = await login(['--to', refusing, '--no-open'])
  assert.match(r.error ?? '', /401 GitHub refused the token\. Sign in again: npx shaderera login$/)
  assert.doesNotMatch(r.error ?? '', /gho_/)
  assert.equal(stored()?.[refusing], undefined)
})

test('without a client id, login says to use --token; --token still works', async () => {
  delete process.env.SHADERERA_GITHUB_CLIENT_ID
  const r = await login(['--to', site])
  assert.equal(r.error, "GitHub sign-in isn't configured yet; use --token")
  assert.equal(github.forms.length, 0)
  // The built-in id is used when the environment gives none.
  github.polls = ['token']
  assert.equal(
    (await login(['--to', site, '--no-open'], deps({ clientId: 'Iv1.built-in' }))).status,
    0,
  )
  assert.equal(github.forms[0]?.form.client_id, 'Iv1.built-in')
  const t = await login(['--token', 'tok-by-hand', '--to', 'https://by-hand.example'])
  assert.equal(t.status, 0)
  assert.doesNotMatch(t.out, /tok-by-hand/)
  assert.equal(stored()['https://by-hand.example'], 'tok-by-hand')
})
