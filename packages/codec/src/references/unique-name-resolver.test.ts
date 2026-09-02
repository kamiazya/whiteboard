import { describe, expect, it } from 'vitest'
import { createUniqueNameResolver } from './unique-name-resolver.js'

describe('createUniqueNameResolver', () => {
  it('resolves an alias exactly one document claims', () => {
    const resolve = createUniqueNameResolver([
      { id: 'A', name: 'Plan' },
      { id: 'B', name: 'Note' },
    ])
    expect(resolve('Plan')).toBe('A')
    expect(resolve('missing')).toBe(null)
  })

  it('answers null for an alias two documents claim', () => {
    const resolve = createUniqueNameResolver([
      { id: 'A', name: 'Plan' },
      { id: 'B', name: 'Plan' },
    ])
    expect(resolve('Plan')).toBe(null)
  })

  it('a document claiming one alias twice is ONE owner, not an ambiguity', () => {
    // Callers feed a path entry AND a name entry per document, so a document
    // NAMED exactly its own path arrives as two claims with one id. The
    // reader navigates that link (daemonLinkEntries dedupes the row), so the
    // resolver must resolve it too — found by the command-sequence property:
    // backlinks dropped a link the preview renders live.
    const resolve = createUniqueNameResolver([
      { id: 'A', name: 'beta/leaf' },
      { id: 'A', name: 'beta/leaf' },
      { id: 'B', name: 'other' },
    ])
    expect(resolve('beta/leaf')).toBe('A')
  })

  it('a same-id claim does not resurrect an alias already ambiguous', () => {
    const resolve = createUniqueNameResolver([
      { id: 'A', name: 'Plan' },
      { id: 'B', name: 'Plan' },
      { id: 'A', name: 'Plan' },
    ])
    expect(resolve('Plan')).toBe(null)
  })
})
