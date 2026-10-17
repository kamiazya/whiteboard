import { describe, expect, it } from 'vitest'
import { formatCoord, sanitizeHref, trustedHref } from './format.js'

describe('formatCoord', () => {
  it('rounds to the fixed decimal precision and strips trailing zeros', () => {
    expect(formatCoord(1.23456)).toBe('1.235')
    expect(formatCoord(2)).toBe('2')
    expect(formatCoord(2.1)).toBe('2.1')
  })

  it('normalizes negative zero to zero', () => {
    expect(formatCoord(-0)).toBe('0')
    expect(formatCoord(0 * -1)).toBe('0')
  })

  it('normalizes a value that becomes negative zero only after ROUNDING', () => {
    // The case the two above cannot reach: they are `-0` before formatting, so
    // the up-front normalization handles them and the second, post-rounding
    // guard never runs. A small negative is `-0.000` after `toFixed`, strips
    // to `-0`, and reaches SVG as a coordinate that differs from `0` byte for
    // byte — which is enough to move a scene digest and a golden.
    expect(formatCoord(-0.0001)).toBe('0')
    expect(formatCoord(-0.0004)).toBe('0')
  })

  it('names the offending value when it rejects one', () => {
    expect(() => formatCoord(Number.NaN)).toThrow(/NaN/)
    expect(() => formatCoord(Number.POSITIVE_INFINITY)).toThrow(/Infinity/)
  })

  it('rejects non-finite input', () => {
    expect(() => formatCoord(Number.NaN)).toThrow()
    expect(() => formatCoord(Number.POSITIVE_INFINITY)).toThrow()
    expect(() => formatCoord(Number.NEGATIVE_INFINITY)).toThrow()
  })

  it('does not use locale-dependent formatting for large numbers', () => {
    // toLocaleString would insert a thousands separator in en-US.
    expect(formatCoord(1234.5)).toBe('1234.5')
  })
})

describe('sanitizeHref', () => {
  it('returns a safe scheme unchanged', () => {
    expect(sanitizeHref('https://example.com')).toBe('https://example.com')
  })

  it('returns a relative/hash link unchanged', () => {
    expect(sanitizeHref('#section')).toBe('#section')
    expect(sanitizeHref('/path')).toBe('/path')
  })

  it('rejects a disallowed scheme', () => {
    expect(sanitizeHref('javascript:alert(1)')).toBe('#')
  })

  it('rejects a scheme obfuscated with a leading tab', () => {
    expect(sanitizeHref('\tjavascript:alert(1)')).toBe('#')
  })

  it('rejects a scheme obfuscated by splitting it with a newline', () => {
    expect(sanitizeHref('java\nscript:alert(1)')).toBe('#')
  })

  it('rejects a scheme obfuscated with a leading space', () => {
    expect(sanitizeHref(' javascript:alert(1)')).toBe('#')
  })

  it('strips EVERY tab/newline, not just the first', () => {
    // The single-separator case above passes whether the strip is global or
    // not, so it pins the normalization without pinning its `g`. Measured
    // with the flag removed: this input comes back UNCHANGED — a live
    // `javascript:` URL emitted into the document — while every other test
    // here stays green.
    expect(sanitizeHref('java\n\nscript:alert(1)')).toBe('#')
    expect(sanitizeHref('j\ta\tv\ta\tscript:alert(1)')).toBe('#')
  })

  it('judges the scheme of the bytes the serializer emits, not of the input', () => {
    // The serializer strips characters XML 1.0 cannot carry (C0/C1 controls,
    // U+FFFE/U+FFFF, lone surrogates). Checked before that strip, each of these
    // looks scheme-less and passes as relative — then reaches the document as
    // a live `javascript:` URL.
    expect(sanitizeHref('java\u0085script:alert(1)')).toBe('#')
    expect(sanitizeHref('java\uFFFEscript:alert(1)')).toBe('#')
    expect(sanitizeHref('j\x01avascript:alert(1)')).toBe('#')
    expect(sanitizeHref('java\uD800script:alert(1)')).toBe('#')
  })

  it('returns the href as it will be emitted, with XML-invalid characters removed', () => {
    expect(sanitizeHref('https://exa\u0085mple.com')).toBe('https://example.com')
    expect(sanitizeHref('docs/\x01a')).toBe('docs/a')
  })

  it('leaves a relative path that merely CONTAINS a colon alone', () => {
    // The scheme pattern is anchored. Unanchored it finds `a:` in the middle
    // of an ordinary path and rewrites a working link to `#` — failing safe,
    // but breaking a link the author wrote.
    expect(sanitizeHref('docs/a:b')).toBe('docs/a:b')
    expect(sanitizeHref('#see:also')).toBe('#see:also')
  })
})

describe('trustedHref', () => {
  it('returns the href it was given, unchanged', () => {
    // The whole body is a brand cast, so emptying it returns `undefined` and
    // every caller writes `href="undefined"` into the document. Tautological
    // to read, and the only thing standing between that and a released SVG.
    expect(trustedHref('#node-01H')).toBe('#node-01H')
    expect(trustedHref('')).toBe('')
  })
})
