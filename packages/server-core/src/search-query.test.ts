import { describe, expect, it } from 'vitest'
import { type SearchQueryInput, searchInputFromQuery, searchQueryString } from './search-query.js'

const readerOf = (query: string) => {
  const params = new URLSearchParams(query)
  return {
    one: (name: string) => params.get(name) ?? undefined,
    all: (name: string) => params.getAll(name),
  }
}

describe('search query string', () => {
  it('names the query q and repeats each tag as tag', () => {
    expect(searchQueryString({ query: 'a b', tags: ['x', 'y'], kind: 'markdown', limit: 5 })).toBe(
      'q=a+b&kind=markdown&tag=x&tag=y&limit=5',
    )
  })

  it('leaves absent fields out', () => {
    expect(searchQueryString({ limit: 10 })).toBe('limit=10')
  })

  it('reads back what it wrote', () => {
    const input: SearchQueryInput = { query: 'plan', tags: ['a', 'b'], kind: 'spatial', limit: 3 }
    expect(searchInputFromQuery(readerOf(searchQueryString(input)))).toEqual(input)
  })

  it('leaves out tags and kind when the string carries none', () => {
    expect(searchInputFromQuery(readerOf('q=hello'))).toEqual({ query: 'hello' })
  })
})
