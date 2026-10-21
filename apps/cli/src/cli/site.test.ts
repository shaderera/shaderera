import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTarget } from './fork.ts'
import { siteOf } from './site.ts'

test('the site: https, or http on this machine only; a fork names a film, a version, or a page', () => {
  assert.equal(siteOf('https://example.com/some/page'), 'https://example.com')
  assert.equal(siteOf('http://127.0.0.1:8787'), 'http://127.0.0.1:8787')
  assert.throws(() => siteOf('http://example.com'), /https/)
  assert.equal(siteOf(undefined), process.env.SHADERERA_SITE ?? 'https://shaderera.com')
  assert.deepEqual(parseTarget('2phicdywpg', 'https://a.example'), {
    site: 'https://a.example',
    film: '2phicdywpg',
  })
  assert.deepEqual(parseTarget('https://b.example/film/2phicdywpg@ab12'), {
    site: 'https://b.example',
    film: '2phicdywpg',
    version: 'ab12',
  })
  assert.throws(() => parseTarget('../etc'), /Not a film/)
})
