import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { trimTrailingSlashes } from './trim-trailing-slashes.js'

// Strings dense in slashes, so trailing runs, interior runs and all-slash
// inputs are common rather than rare.
const slashy = fc.string({ unit: fc.constantFrom('/', 'a', ':', '.'), maxLength: 24 })

describe('trimTrailingSlashes', () => {
  it('drops every trailing slash and nothing else', () => {
    expect(trimTrailingSlashes('http://127.0.0.1:3099///')).toBe('http://127.0.0.1:3099')
    expect(trimTrailingSlashes('http://127.0.0.1:3099')).toBe('http://127.0.0.1:3099')
    expect(trimTrailingSlashes('a//b/')).toBe('a//b')
    expect(trimTrailingSlashes('///')).toBe('')
    expect(trimTrailingSlashes('')).toBe('')
  })

  // The regex is the reference here, not the subject: on short inputs its
  // cost is irrelevant and its meaning is the behaviour being preserved.
  fcTest.prop([slashy], withDefaults())('agrees with /\\/+$/ on every input', (s) => {
    expect(trimTrailingSlashes(s)).toBe(s.replace(/\/+$/, ''))
  })

  // `/\/+$/` retries from every start of a slash run that ends in anything
  // else: 100k slashes then one character took about 9s.
  it('is linear in a long slash run that does not end the string', () => {
    const input = `${'/'.repeat(100_000)}x`
    const started = performance.now()
    expect(trimTrailingSlashes(input)).toBe(input)
    expect(performance.now() - started).toBeLessThan(500)
  })
})
