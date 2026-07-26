import { describe, expect, it } from 'vitest'
import { parseOkf } from './parse.js'
import { serializeOkf } from './serialize.js'

describe('serializeOkf', () => {
  it('emits facets-domain keys in canonical lexicographic order regardless of authoring order', () => {
    const text = serializeOkf({
      frontmatter: {
        type: 'note',
        facets: {
          'zeta/1': { z: 1 },
          'alpha/2': { a: 1 },
          'mu/1': { m: 1 },
        },
      },
      body: 'hello',
    })

    const facetsBlock = text.slice(text.indexOf('facets:'), text.indexOf('body:') || undefined)
    const firstKeyIndex = ['alpha/2', 'mu/1', 'zeta/1']
      .map((key) => facetsBlock.indexOf(key))
      .filter((index) => index !== -1)
    expect(firstKeyIndex).toEqual([...firstKeyIndex].sort((a, b) => a - b))
    expect(facetsBlock.indexOf('alpha/2')).toBeLessThan(facetsBlock.indexOf('mu/1'))
    expect(facetsBlock.indexOf('mu/1')).toBeLessThan(facetsBlock.indexOf('zeta/1'))
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

  it('surfaces a typed error instead of throwing when a facet value is not yaml-safe', () => {
    expect(() =>
      serializeOkf({
        frontmatter: { type: 'note', facets: { 'x/1': { bad: Number.NaN } } },
        body: '',
      }),
    ).toThrow(/yaml-safe/)
  })
})
