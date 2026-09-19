import { describe, expect, it } from 'vitest'
import { parseOkf } from './parse.js'
import { serializeOkf } from './serialize.js'

describe('serializeOkf', () => {
  it('emits facets-domain keys in canonical lexicographic order regardless of authoring order', () => {
    const text = serializeOkf({
      frontmatter: {
        type: 'note',
        facets: {
          'zeta.z/v1': { z: 1 },
          'alpha.a/v2': { a: 1 },
          'mu.m/v1': { m: 1 },
        },
      },
      body: 'hello',
    })

    const facetsBlock = text.slice(text.indexOf('facets:'), text.indexOf('body:') || undefined)
    const firstKeyIndex = ['alpha.a/v2', 'mu.m/v1', 'zeta.z/v1']
      .map((key) => facetsBlock.indexOf(key))
      .filter((index) => index !== -1)
    expect(firstKeyIndex).toEqual([...firstKeyIndex].sort((a, b) => a - b))
    expect(facetsBlock.indexOf('alpha.a/v2')).toBeLessThan(facetsBlock.indexOf('mu.m/v1'))
    expect(facetsBlock.indexOf('mu.m/v1')).toBeLessThan(facetsBlock.indexOf('zeta.z/v1'))
  })

  it('round-trips a minimal document through parseOkf', () => {
    const text = serializeOkf({ frontmatter: { type: 'note', title: 'Hi' }, body: 'body text' })
    const result = parseOkf(text)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected success')
    expect(result.value.frontmatter.type).toBe('note')
    expect(result.value.frontmatter.title).toBe('Hi')
    expect(result.value.body).toBe('body text')
  })

  it('keeps a last value that ends in a Unicode space, which JS trimEnd() would take', () => {
    // U+2000 and U+00A0 are whitespace to `String.prototype.trimEnd` and
    // printable characters to YAML, so yaml writes them bare at the end of
    // the last line; a trimEnd() over the whole text then left `view:` with
    // nothing after it, and parseOkf read the value back as null. Found by
    // the round-trip property (seed -1838762366).
    for (const view of ['\u2000', 'x\u00a0']) {
      const text = serializeOkf({ frontmatter: { type: 'note', view }, body: '' })
      const result = parseOkf(text)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.frontmatter.view).toBe(view)
    }
  })

  it('surfaces a typed error instead of throwing when a facet value is not yaml-safe', () => {
    expect(() =>
      serializeOkf({
        frontmatter: { type: 'note', facets: { 'x.y/v1': { bad: Number.NaN } } },
        body: '',
      }),
    ).toThrow(/yaml-safe/)
  })
})

describe('serializeOkf spreads facetsRaw back at the root (OKF §4.1)', () => {
  it('emits preserved keys as root frontmatter, never as a nested `facetsRaw:` key', () => {
    const text = serializeOkf({
      frontmatter: {
        type: 'Metric',
        title: 'Revenue',
        facetsRaw: { status: 'stable', description: 'one line' },
      },
      body: 'body',
    })

    expect(text).toContain('\nstatus: stable\n')
    expect(text).toContain('\ndescription: one line\n')
    expect(text).not.toContain('facetsRaw:')
  })

  it('emits preserved keys in canonical lexicographic order', () => {
    const text = serializeOkf({
      frontmatter: { type: 'note', facetsRaw: { zeta: 1, alpha: 2, mu: 3 } },
      body: '',
    })

    expect(text.indexOf('alpha:')).toBeLessThan(text.indexOf('mu:'))
    expect(text.indexOf('mu:')).toBeLessThan(text.indexOf('zeta:'))
  })

  it('rejects a preserved value that is not yaml-safe, like any other frontmatter value', () => {
    expect(() =>
      serializeOkf({ frontmatter: { type: 'note', facetsRaw: { bad: Number.NaN } }, body: '' }),
    ).toThrow(/yaml-safe/)
  })
})
