/**
 * The list page mounted the way PRODUCTION mounts it: `index` and
 * `onOpenDocument` only, every other collaborator left to its default.
 *
 * Real IndexedDB, because the defaults under test ARE the IndexedDB-backed
 * ones — a jsdom test that supplies its own clock is exactly the test that
 * cannot see this.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { clearWhiteboardDb } from '../test-utils/browser-local-document.js'
import { BrowserLocalIndexPage } from './BrowserLocalIndexPage.js'

describe('list page, production wiring', () => {
  beforeEach(clearWhiteboardDb)
  afterEach(cleanup)

  it('reads the index once, not once per render', async () => {
    // A default evaluated in the parameter list is a NEW value every render.
    // The load effect depends on the clock, so it re-runs, `setSnapshots`
    // stores a new array, the render makes another clock, and the effect runs
    // again — forever, on the one path production actually takes.
    const index = new IdbDocumentIndex()
    const spy = vi.spyOn(index, 'listDocuments')
    render(
      <MemoryRouter initialEntries={['/']}>
        <BrowserLocalIndexPage index={index} onOpenDocument={() => {}} />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy(), {
      timeout: 5000,
    })
    await waitFor(() => expect(spy).toHaveBeenCalled(), { timeout: 5000 })

    // Settle, then assert the count STOPPED climbing rather than that it is
    // small — a loop this fast is already in the hundreds by now, but a slow
    // machine could make any fixed bound pass by accident.
    const settled = spy.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(spy.mock.calls.length).toBe(settled)
    expect(settled).toBeLessThanOrEqual(2)
  })
})
