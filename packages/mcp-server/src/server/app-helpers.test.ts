import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../shared/test-utils/fast-check.js'
import { isReservedUiPath, setBaselineSecurityHeaders, toInlineScriptJson } from './app-helpers.js'

describe('toInlineScriptJson', () => {
  it('escapes </script> so an inlined value cannot terminate the surrounding <script> tag', () => {
    const output = toInlineScriptJson('</script><script>alert(1)</script>')
    expect(output).not.toContain('</script')
    expect(output).not.toContain('<')
  })

  it('serializes a plain safe value unchanged (no mangling of the common case)', () => {
    expect(toInlineScriptJson({ port: 3099 })).toBe(JSON.stringify({ port: 3099 }))
  })

  // Shrunk fast-check counterexample, pinned: JSON itself has no negative
  // zero on serialize (JSON.stringify(-0) === "0"), so the round trip lands
  // on +0. The property below therefore compares modulo JSON's own value
  // model, not against the input verbatim.
  it('normalizes -0 to 0, exactly as JSON.stringify does', () => {
    expect(toInlineScriptJson([-0])).toBe('[0]')
    expect(Object.is(JSON.parse(toInlineScriptJson([-0]))[0], 0)).toBe(true)
  })

  // Bias string content toward '<': JSON values drawn uniformly almost never
  // contain it, which would make this property pass vacuously even with the
  // escape deleted.
  const jsonValue = fc.jsonValue({ stringUnit: fc.constantFrom('<', '/script>', 'a') })

  fcTest.prop([jsonValue], withDefaults())(
    'escape is complete and semantics-preserving for any JSON value',
    (value) => {
      const output = toInlineScriptJson(value)
      expect(output).not.toContain('<')
      // Compared against JSON's own projection of the value, not the value:
      // JSON.stringify collapses -0 to 0 (fc.jsonValue generates -0, found
      // by seed 1616450870), and that loss is JSON's, not the escape's. The
      // invariant worth stating is that the ESCAPE adds no loss beyond it.
      expect(JSON.parse(output)).toEqual(JSON.parse(JSON.stringify(value)))
    },
  )
})

describe('isReservedUiPath', () => {
  it.each([
    ['/api', true],
    ['/api/x', true],
    ['/mcp', true],
    ['/mcp/tools', true],
    ['/ws', true],
    ['/ws/anything', true],
    ['/.well-known/oauth-authorization-server', true],
    ['/token', true],
    ['/', false],
    ['/apix', false],
    ['/api2', false],
    ['/mcpx', false],
    ['/wsx', false],
    ['/.well-known', false],
    ['/token/refresh', false],
    ['/w/default/canvas/foo', false],
    ['/tokens', false],
    ['/local/abc', false],
  ])('isReservedUiPath(%s) === %s', (path, expected) => {
    expect(isReservedUiPath(path)).toBe(expected)
  })
})

describe('setBaselineSecurityHeaders', () => {
  it('does not clobber a pre-set Content-Security-Policy', () => {
    const headers = new Headers({ 'Content-Security-Policy': "default-src 'none'" })
    setBaselineSecurityHeaders(headers)
    expect(headers.get('Content-Security-Policy')).toBe("default-src 'none'")
  })

  it('sets the floor CSP plus the unconditional headers on empty Headers', () => {
    const headers = new Headers()
    setBaselineSecurityHeaders(headers)
    expect(headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'")
    expect(headers.get('X-Frame-Options')).toBe('DENY')
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin')
    expect(headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin')
  })

  it('overwrites a pre-set unconditional header (only CSP is guarded)', () => {
    const headers = new Headers({ 'X-Frame-Options': 'SAMEORIGIN' })
    setBaselineSecurityHeaders(headers)
    expect(headers.get('X-Frame-Options')).toBe('DENY')
  })
})
