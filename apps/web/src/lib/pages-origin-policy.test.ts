import { describe, expect, it } from 'vitest'
import {
  classifyPagesOrigin,
  isProductionPagesOrigin,
  PROVISIONAL_PRODUCTION_ORIGIN,
} from './pages-origin-policy.js'

describe('PROVISIONAL_PRODUCTION_ORIGIN', () => {
  it('is the provisional pages.dev production origin', () => {
    expect(PROVISIONAL_PRODUCTION_ORIGIN).toBe('https://whiteboard.pages.dev')
  })
})

describe('classifyPagesOrigin', () => {
  it('classifies the provisional production origin as production', () => {
    expect(classifyPagesOrigin('https://whiteboard.pages.dev')).toBe('production')
  })

  it('classifies a preview subdomain as preview', () => {
    expect(classifyPagesOrigin('https://abc123.whiteboard.pages.dev')).toBe('preview')
  })

  it('classifies an arbitrary hash subdomain as preview', () => {
    expect(classifyPagesOrigin('https://evil-hash.whiteboard.pages.dev')).toBe('preview')
  })

  it('classifies http origin as insecure', () => {
    expect(classifyPagesOrigin('http://whiteboard.pages.dev')).toBe('insecure')
  })

  it('classifies http localhost as insecure (not localhost) since insecure takes precedence', () => {
    // http scheme is checked before localhost hostname
    expect(classifyPagesOrigin('http://localhost:5173')).toBe('insecure')
  })

  it('classifies https localhost as localhost', () => {
    expect(classifyPagesOrigin('https://localhost:5173')).toBe('localhost')
  })

  it('classifies 127.0.0.1 as localhost', () => {
    expect(classifyPagesOrigin('https://127.0.0.1:3099')).toBe('localhost')
  })

  it('classifies origin with path as non-bare-origin', () => {
    expect(classifyPagesOrigin('https://whiteboard.pages.dev/path')).toBe('non-bare-origin')
  })

  it('classifies origin with query string as non-bare-origin', () => {
    expect(classifyPagesOrigin('https://whiteboard.pages.dev?q=1')).toBe('non-bare-origin')
  })

  it('classifies origin with fragment as non-bare-origin', () => {
    expect(classifyPagesOrigin('https://whiteboard.pages.dev#hash')).toBe('non-bare-origin')
  })

  it('classifies origin with credentials as non-bare-origin', () => {
    expect(classifyPagesOrigin('https://user:pass@whiteboard.pages.dev')).toBe('non-bare-origin')
  })

  it('classifies wildcard hostname as non-bare-origin', () => {
    expect(classifyPagesOrigin('https://*.pages.dev')).toBe('non-bare-origin')
  })

  it('classifies an invalid string as non-bare-origin', () => {
    expect(classifyPagesOrigin('not-a-url')).toBe('non-bare-origin')
  })

  it('classifies empty string as non-bare-origin', () => {
    expect(classifyPagesOrigin('')).toBe('non-bare-origin')
  })

  it('classifies a custom domain as custom-domain-deferred', () => {
    expect(classifyPagesOrigin('https://custom.example.com')).toBe('custom-domain-deferred')
  })

  it('classifies a different pages.dev project as custom-domain-deferred', () => {
    expect(classifyPagesOrigin('https://other-project.pages.dev')).toBe('custom-domain-deferred')
  })
})

describe('isProductionPagesOrigin', () => {
  it('returns true for provisional production origin', () => {
    expect(isProductionPagesOrigin('https://whiteboard.pages.dev')).toBe(true)
  })

  it('returns false for preview origin', () => {
    expect(isProductionPagesOrigin('https://abc123.whiteboard.pages.dev')).toBe(false)
  })

  it('returns false for localhost', () => {
    expect(isProductionPagesOrigin('https://localhost:5173')).toBe(false)
  })

  it('returns false for insecure origin', () => {
    expect(isProductionPagesOrigin('http://whiteboard.pages.dev')).toBe(false)
  })
})

// PBT justification: classifyPagesOrigin is a finite 6-case decision table
// (production / preview / insecure / localhost / non-bare-origin / custom-domain-deferred).
// Every branch has a direct example test. No property-based framework added.
