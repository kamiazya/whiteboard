/**
 * A note's Properties form edits one field at a time, each built on
 * `coreFacets`. Read back only after the session's commit debounce, a second
 * field typed inside that window was built on the facets WITHOUT the first,
 * and its write replaced them — the first field was gone after a reload.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it } from 'vitest'
import { FakeBrowserBackend } from '../test-utils/fake-browser-backend.js'
import { useDocumentSync } from './useDocumentSync.js'

it('publishes a facets edit at once, so a second edit inside the debounce builds on it', async () => {
  const backend = new FakeBrowserBackend({
    documentId: '0W16BGNTZ49EKRX27CHPV05AFN',
    path: 'notes/plan',
    kind: 'markdown',
  })
  const { result } = renderHook(() => useDocumentSync(backend))
  await waitFor(() => expect(result.current.loaded).toBe(true))

  act(() => {
    result.current.setCoreFacets({ type: 'markdown', description: 'Orders.' })
  })

  expect(result.current.coreFacets).toEqual({ type: 'markdown', description: 'Orders.' })
})
