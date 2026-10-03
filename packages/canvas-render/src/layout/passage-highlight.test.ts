import { describe, expect, it } from 'vitest'
import { findPassage } from './passage-highlight.js'

describe('findPassage picks the occurrence whose surroundings match best', () => {
  const rendered = 'alpha foo omega beta foo gamma'
  const first = rendered.indexOf('foo')
  const last = rendered.lastIndexOf('foo')

  it('uses the prefix to choose between two identical quotes', () => {
    const found = findPassage(rendered, { exact: 'foo', prefix: 'beta ' })
    expect(found && rendered.slice(found.start, found.end)).toBe('foo')
    expect(found?.start).toBe(last)
  })

  it('uses the suffix when there is no prefix', () => {
    expect(findPassage(rendered, { exact: 'foo', suffix: ' omega' })?.start).toBe(first)
    expect(findPassage(rendered, { exact: 'foo', suffix: ' gamma' })?.start).toBe(last)
  })

  it('gives a tie to the first occurrence', () => {
    expect(findPassage(rendered, { exact: 'foo' })?.start).toBe(first)
  })

  it('keeps the best of three occurrences against a later weaker one', () => {
    const text = 'x foo y. a foo b. foo'
    const found = findPassage(text, { exact: 'foo', prefix: 'a ', suffix: ' b' })
    expect(found?.start).toBe(text.indexOf('a foo') + 2)
  })

  it('answers null for a blank or absent quote', () => {
    expect(findPassage(rendered, { exact: '  ' })).toBeNull()
    expect(findPassage(rendered, { exact: 'missing' })).toBeNull()
  })
})
