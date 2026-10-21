import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTarget } from './fork.ts'
import { apiOf, firstLine, siteOf } from './site.ts'

test('the site and the API: https, or http on this machine only; a fork names a film, a version, or a page', () => {
  assert.equal(siteOf('https://example.com/some/page'), 'https://example.com')
  assert.equal(siteOf('http://127.0.0.1:8787'), 'http://127.0.0.1:8787')
  assert.throws(() => siteOf('http://example.com'), /--site is reached over https/)
  assert.throws(() => apiOf('http://example.com'), /--api is reached over https/)
  assert.throws(() => apiOf('example.com'), /Not an origin: example\.com \(--api takes one/)
  assert.equal(siteOf(undefined), process.env.SHADERERA_SITE ?? 'https://shaderera.com')
  assert.equal(apiOf(undefined), process.env.SHADERERA_API ?? 'https://api.shaderera.com')
  const at = { site: 'https://a.example', api: 'https://api.a.example' }
  assert.deepEqual(parseTarget('2phicdywpg', at), { film: '2phicdywpg' })
  // The site's page, and the API's own address, name the film; another origin is refused.
  assert.deepEqual(parseTarget('https://a.example/film/2phicdywpg@ab12', at), {
    film: '2phicdywpg',
    version: 'ab12',
  })
  assert.deepEqual(parseTarget('https://api.a.example/api/v1/films/2phicdywpg', at), {
    film: '2phicdywpg',
  })
  assert.throws(
    () => parseTarget('https://b.example/film/2phicdywpg', at),
    /https:\/\/b\.example is not the site \(https:\/\/a\.example\) nor the films API/,
  )
  assert.throws(() => parseTarget('../etc', at), /Not a film/)
})

test("an answer that is not the API's shows its first line, never a whole page", () => {
  assert.equal(firstLine('<!doctype html>\n<html><body>Not found</body></html>'), '<!doctype html>')
  assert.equal(firstLine(`  ${'x'.repeat(200)}\r\nmore`), `${'x'.repeat(119)}…`)
  assert.equal(firstLine(''), '')
})
