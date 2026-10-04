import { describe, expect, it } from 'vitest'
import { isLoopbackHostname } from './loopback-host.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

describe('isLoopbackHostname', () => {
  it.each(['localhost', '127.0.0.1', '[::1]'])('accepts %s', (host) => {
    expect(isLoopbackHostname(host)).toBe(true)
  })

  it.each([
    'localhost.evil.example',
    '127.0.0.1.evil.example',
    '127.0.0.2',
    '0.0.0.0',
    '[::2]',
    // A URL never reports the bare form, so it is not a loopback hostname.
    '::1',
    'localhost:3099',
    'example.com',
    'LOCALHOST',
    '',
  ])('refuses %s', (host) => {
    expect(isLoopbackHostname(host)).toBe(false)
  })
})

// The set is judged against what `URL` itself reports, since that is the only
// input either root passes.
const LOOPBACK_SPELLINGS = [
  'localhost',
  'LOCALHOST',
  '127.0.0.1',
  '127.1',
  '2130706433',
  '[::1]',
  '[0:0:0:0:0:0:0:1]',
] as const

const portArb = fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined })
const pathArb = fc.constantFrom('', '/', '/a/b?x=1#frag')
const userinfoArb = fc.constantFrom('', 'user@', 'user:pw@')
const schemeArb = fc.constantFrom('http', 'https', 'ws')

describe('isLoopbackHostname over what URL reports', () => {
  fcTest.prop(
    [schemeArb, userinfoArb, fc.constantFrom(...LOOPBACK_SPELLINGS), portArb, pathArb],
    withDefaults(),
  )(
    'every spelling of this machine is recognised once parsed',
    (scheme, userinfo, host, port, path) => {
      const url = new URL(
        `${scheme}://${userinfo}${host}${port === undefined ? '' : `:${port}`}${path}`,
      )

      expect(isLoopbackHostname(url.hostname)).toBe(true)
    },
  )

  fcTest.prop(
    [
      schemeArb,
      fc.oneof(
        fc.constantFrom('.evil.example', '.', 'x').map((tail) => `localhost${tail}`),
        fc.constantFrom('x', 'a.').map((head) => `${head}localhost`),
        fc.integer({ min: 2, max: 255 }).map((last) => `127.0.0.${last}`),
        fc.integer({ min: 2, max: 0xffff }).map((last) => `[::${last.toString(16)}]`),
      ),
    ],
    withDefaults(),
  )('a host that only resembles loopback is not one', (scheme, host) => {
    expect(isLoopbackHostname(new URL(`${scheme}://${host}/`).hostname)).toBe(false)
  })
})
