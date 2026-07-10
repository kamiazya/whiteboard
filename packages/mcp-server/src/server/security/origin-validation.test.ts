import { describe, expect, it } from 'vitest'
import { validateOriginEntry } from './origin-validation.js'

describe('validateOriginEntry', () => {
  it('accepts an exact https origin', () => {
    const result = validateOriginEntry('https://kamiazya-whiteboard.pages.dev')
    expect(result).toEqual({ ok: true, origin: 'https://kamiazya-whiteboard.pages.dev' })
  })

  it('normalizes a trailing slash to the bare origin', () => {
    const result = validateOriginEntry('https://kamiazya-whiteboard.pages.dev/')
    expect(result).toEqual({ ok: true, origin: 'https://kamiazya-whiteboard.pages.dev' })
  })

  it('normalizes host case and collapses the default port', () => {
    const result = validateOriginEntry('https://Example.com:443')
    expect(result).toEqual({ ok: true, origin: 'https://example.com' })
  })

  it('keeps a non-default port significant', () => {
    const result = validateOriginEntry('https://example.com:8443')
    expect(result).toEqual({ ok: true, origin: 'https://example.com:8443' })
  })

  it('rejects the wildcard entry', () => {
    expect(validateOriginEntry('*')).toEqual({ ok: false, reason: 'wildcard' })
  })

  it('rejects http:// scheme', () => {
    expect(validateOriginEntry('http://kamiazya-whiteboard.pages.dev')).toEqual({
      ok: false,
      reason: 'not_https',
    })
  })

  it('rejects a path suffix', () => {
    expect(validateOriginEntry('https://example.com/app')).toEqual({
      ok: false,
      reason: 'not_origin',
    })
  })

  it('rejects a query string', () => {
    expect(validateOriginEntry('https://example.com/?x=1')).toEqual({
      ok: false,
      reason: 'not_origin',
    })
  })

  it('rejects a fragment', () => {
    expect(validateOriginEntry('https://example.com/#frag')).toEqual({
      ok: false,
      reason: 'not_origin',
    })
  })

  it('rejects embedded credentials', () => {
    expect(validateOriginEntry('https://user:pass@example.com')).toEqual({
      ok: false,
      reason: 'not_origin',
    })
  })

  it('rejects an unparseable value', () => {
    expect(validateOriginEntry('not a url')).toEqual({ ok: false, reason: 'unparseable' })
  })
})
