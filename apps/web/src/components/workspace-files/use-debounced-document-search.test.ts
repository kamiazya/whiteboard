import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDebouncedDocumentSearch } from './use-debounced-document-search.js'

describe('useDebouncedDocumentSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function searchFor(query: string) {
    const searchDocuments = vi.fn().mockResolvedValue([])
    const { result } = renderHook(() => useDebouncedDocumentSearch({ searchDocuments }, 0))
    act(() => {
      result.current.setQuery(query)
    })
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    return { searchDocuments, result }
  }

  // A leading `#` asks the panel for a tag filter, which the list it holds
  // answers; sending it to the content search would rank prose for "#ops".
  it('leaves a query that starts with # to the tag filter', () => {
    const { searchDocuments, result } = searchFor(' #ops')
    expect(searchDocuments).not.toHaveBeenCalled()
    expect(result.current.hits).toBeNull()
  })

  it('searches content for a query with # anywhere but its start', () => {
    const { searchDocuments } = searchFor('C#')
    expect(searchDocuments).toHaveBeenCalledWith('C#', expect.any(Number))
  })
})
