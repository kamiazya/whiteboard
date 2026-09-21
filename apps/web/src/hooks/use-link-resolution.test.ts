import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { LinkableDocument } from '../lib/link-entries.js'
import { useLinkResolution } from './use-link-resolution.js'

const A: LinkableDocument = { id: 'doc-a', path: 'notes/alpha', displayName: 'Alpha' }
const B: LinkableDocument = { id: 'doc-b', path: 'notes/beta' }

describe('useLinkResolution', () => {
  it('labels a link by its display name, falling back to the path', () => {
    const { result } = renderHook(() => useLinkResolution({ documents: [A, B] }))

    expect(result.current.resolveTitle('doc-a')).toBe('Alpha')
    // B has no name of its own, which is how the index spells "never named".
    expect(result.current.resolveTitle('doc-b')).toBe('notes/beta')
    expect(result.current.resolveTitle('doc-gone')).toBeUndefined()
  })

  it('treats a ref as missing only when it matches neither an id NOR a path', () => {
    // Both, because a stored ref may be either: a file node keys on the id
    // (ADR-0008) and a legacy ref carries the path. Dropping either half makes
    // half the live refs read as deleted, and the editor draws them as a quiet
    // "Missing reference" — a silent loss, which is why this has its own case.
    const { result } = renderHook(() => useLinkResolution({ documents: [A, B] }))
    const missing = result.current.missingFileRef

    expect(missing?.('doc-a')).toBe(false)
    expect(missing?.('notes/alpha')).toBe(false)
    expect(missing?.('doc-b')).toBe(false)
    expect(missing?.('notes/beta')).toBe(false)
    expect(missing?.('notes/deleted')).toBe(true)
  })

  it('answers undefined before the list has loaded, so nothing reads as missing yet', () => {
    // An empty list is "not loaded", not "the workspace is empty": answering
    // `true` for every ref would draw every reference on screen as broken for
    // as long as the first load takes.
    const { result } = renderHook(() => useLinkResolution({ documents: [] }))

    expect(result.current.missingFileRef).toBeUndefined()
  })

  it('offers the picker what pickerDocuments says, not the resolution list', () => {
    // The browser page passes a different list here on purpose: the open
    // document's row is overlaid with its live snapshot, so the picker never
    // offers a stale name for the document being edited. A hook that ignored
    // the override would reintroduce exactly that.
    const overlaid: LinkableDocument = { ...A, displayName: 'Alpha, renamed but unsaved' }
    const { result } = renderHook(() =>
      useLinkResolution({ documents: [A, B], pickerDocuments: [overlaid, B] }),
    )

    expect(result.current.pickerTargets.map((t) => t.name)).toEqual([
      'Alpha, renamed but unsaved',
      'notes/beta',
    ])
    // …and the resolution list is untouched by the overlay.
    expect(result.current.resolveTitle('doc-a')).toBe('Alpha')
  })

  it('never offers the open document as a link target', () => {
    const { result } = renderHook(() =>
      useLinkResolution({ documents: [A, B], excludeDocumentId: 'doc-a' }),
    )

    expect(result.current.pickerTargets.map((t) => t.id)).toEqual(['doc-b'])
  })

  it('resolves a written path to its document', () => {
    const { result } = renderHook(() => useLinkResolution({ documents: [A, B] }))

    expect(result.current.resolveAlias('notes/alpha')).toBe('doc-a')
  })
})
