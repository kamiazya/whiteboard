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
import { userEvent } from 'vitest/browser'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserIndexPage } from './BrowserIndexPage.js'

claimIsolatedWhiteboardDb('browserindexpage-defaults')

describe('list page, production wiring', () => {
  beforeEach(clearWhiteboardDb)
  afterEach(cleanup)

  it('a create lands in this mount own list - Back can arrive before it ever unmounts', async () => {
    // react-router wraps navigation in startTransition, so the editor's lazy
    // chunk loads while THIS page is still mounted; a Back in that window
    // returns to this same mount. Its list has to carry the document it just
    // created, or onboarding sticks over a store that has one.
    render(
      <MemoryRouter initialEntries={['/']}>
        <BrowserIndexPage index={new IdbDocumentIndex()} onOpenDocument={() => {}} />
      </MemoryRouter>,
    )
    await screen.findByText('What will you make first?', undefined, { timeout: 10_000 })
    await userEvent.click(screen.getByRole('button', { name: 'Create a canvas' }))
    const cards = await screen.findAllByTestId('card-title', undefined, { timeout: 10_000 })
    expect(cards).toHaveLength(1)
    expect(screen.queryByText('What will you make first?')).toBeNull()
  })

  it('reads the index once, not once per render', async () => {
    // A default evaluated in the parameter list is a NEW value every render.
    // The load effect depends on the clock, so it re-runs, `setSnapshots`
    // stores a new array, the render makes another clock, and the effect runs
    // again — forever, on the one path production actually takes.
    const index = new IdbDocumentIndex()
    const spy = vi.spyOn(index, 'listDocuments')
    render(
      <MemoryRouter initialEntries={['/']}>
        <BrowserIndexPage index={index} onOpenDocument={() => {}} />
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
