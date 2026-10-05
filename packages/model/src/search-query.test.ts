import { describe, expect, it } from 'vitest'
import { SEARCH_QUERY_MAX_CHARS, searchQueryInputSchema } from './search-query.js'

const messageOf = (parsed: { success: boolean; error?: { issues: { message: string }[] } }) =>
  parsed.success ? '' : (parsed.error?.issues[0]?.message ?? '')

describe('a search query as a tool or route accepts it', () => {
  it('holds the words to 1,024 characters', () => {
    // A literal, not the constant: every other case reads the limit back
    // from itself, so a changed limit would pass them all.
    expect(SEARCH_QUERY_MAX_CHARS).toBe(1024)
    expect(searchQueryInputSchema.safeParse('a'.repeat(1024)).success).toBe(true)
    expect(searchQueryInputSchema.safeParse('a'.repeat(1025)).success).toBe(false)
  })

  it('refuses in words that name the limit', () => {
    expect(
      messageOf(searchQueryInputSchema.safeParse('a'.repeat(SEARCH_QUERY_MAX_CHARS + 1))),
    ).toBe(`a search query is longer than the ${SEARCH_QUERY_MAX_CHARS}-character limit`)
  })

  it('still refuses empty words', () => {
    expect(searchQueryInputSchema.safeParse('').success).toBe(false)
  })
})
