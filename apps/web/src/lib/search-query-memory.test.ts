import { describe, expect, it } from 'vitest'
import { recallSearchQuery, rememberSearchQuery } from './search-query-memory.js'

describe('search query memory', () => {
  it('returns what a scope last held, and nothing for another scope', () => {
    rememberSearchQuery('a', 'roadmap')
    expect(recallSearchQuery('a')).toBe('roadmap')
    expect(recallSearchQuery('b')).toBe('')
  })

  it('forgets a scope whose box was cleared', () => {
    rememberSearchQuery('c', 'x')
    rememberSearchQuery('c', '')
    expect(recallSearchQuery('c')).toBe('')
  })

  it('remembers nothing without a scope', () => {
    rememberSearchQuery(undefined, 'x')
    expect(recallSearchQuery(undefined)).toBe('')
  })
})
