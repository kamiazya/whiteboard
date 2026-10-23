import { writeMarkdownBody } from '@kamiazya/whiteboard-loro-adapter'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { Loro } from 'loro-crdt'
import { useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { FoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { BrowserDocumentPage } from './BrowserDocumentPage.js'
import '../index.css'
import { createBrowserFilesSource } from '../lib/browser-files-source.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { renderPage } from '../test-utils/daemon-page-harness.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { useRecordPushes } from '../test-utils/record-pushes.js'
import { seedWorkspaceDocumentContent } from '../test-utils/seed-workspace-content.js'

claimIsolatedWhiteboardDb('browserdocumentpage-first-rename')

// The router's own history object sees every push and replace, including a
// push that a replace in the same commit covers before any render observes it.
const pushed: string[] = []

function AddressProbe() {
  const location = useLocation()
  useRecordPushes(pushed)
  return <output data-testid="address">{location.pathname}</output>
}

async function renderLoaded(store = new FoldingBrowserIndex()): Promise<FoldingBrowserIndex> {
  renderPage(
    <>
      <AddressProbe />
      <BrowserDocumentPage store={store} />
    </>,
  )
  await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(), {
    timeout: 5000,
  })
  return store
}

async function titleField(): Promise<HTMLElement> {
  const all = await waitFor(() => screen.getAllByRole('textbox', { name: /^title$/i }), {
    timeout: 5000,
  })
  return all[all.length - 1]!
}

/** Types the way a person does — one change per keystroke — then leaves the field. */
async function typeTitle(text: string): Promise<void> {
  const field = await titleField()
  field.focus()
  for (let i = 1; i <= text.length; i++) {
    fireEvent.change(field, { target: { value: text.slice(0, i) } })
  }
  field.blur()
}

/**
 * The rename's write has LANDED, from the persistence facts the page
 * publishes hidden. `saved` alone is true of a document never written, so
 * the timestamp is what proves it.
 */
async function waitForWriteLanded(): Promise<void> {
  await waitFor(
    () => {
      const fact = screen.getByTestId('persistence-state')
      expect(fact.getAttribute('data-save-state')).toBe('saved')
      expect(fact.getAttribute('data-last-saved-at')).toBeTruthy()
    },
    { timeout: 5000 },
  )
}

const address = () => screen.getByTestId('address')

describe('BrowserDocumentPage first rename (real IndexedDB)', () => {
  beforeEach(async () => {
    pushed.length = 0
    await clearWhiteboardDb()
  })
  afterEach(() => {
    cleanup()
  })

  it('moves a default path to the name once the title is finished, and replaces the address', async () => {
    const store = await renderLoaded()
    await waitFor(() => expect(address().textContent).toMatch(/\/d\/untitled$/))

    await typeTitle('Checkout Architecture')

    await waitFor(() => expect(address().textContent).toMatch(/\/d\/checkout-architecture$/), {
      timeout: 5000,
    })
    expect(pushed).toEqual([])
    // The editor stayed mounted and the keeper holds the document at one path.
    expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument()
    const held = await store.listDocuments({ workspaceId: getBrowserWorkspaceId() })
    expect(held.map((entry) => entry.path)).toEqual(['checkout-architecture'])
  })

  it('repoints a [[path]] link written against the generated path', async () => {
    const store = await renderLoaded()
    const files = createBrowserFilesSource({ index: store })
    await files.createDocument('notes', 'markdown')
    const notes = (await files.listDocuments()).find((entry) => entry.path === 'notes')
    const body = new Loro()
    writeMarkdownBody(body, 'back to [[untitled]] soon')
    await seedWorkspaceDocumentContent(notes?.documentId ?? '', body.export({ mode: 'snapshot' }))

    await typeTitle('Checkout Architecture')
    await waitFor(() => expect(address().textContent).toMatch(/\/d\/checkout-architecture$/), {
      timeout: 5000,
    })

    await waitFor(
      async () => {
        const hits = await files.searchDocuments('checkout-architecture')
        expect(hits.map((hit) => hit.document.path)).toContain('notes')
      },
      { timeout: 5000 },
    )
  })

  it('does not chase the name while it is still being typed', async () => {
    const store = await renderLoaded()
    const move = vi.spyOn(store, 'moveDocument')
    const field = await titleField()
    field.focus()
    fireEvent.change(field, { target: { value: 'C' } })
    fireEvent.change(field, { target: { value: 'Ch' } })
    await waitForWriteLanded()
    expect(move).not.toHaveBeenCalled()
    expect(address().textContent).toMatch(/\/d\/untitled$/)
  })

  it('leaves the path alone on every later rename', async () => {
    const store = await renderLoaded()
    const move = vi.spyOn(store, 'moveDocument')
    await typeTitle('Checkout Architecture')
    await waitFor(() => expect(address().textContent).toMatch(/\/d\/checkout-architecture$/), {
      timeout: 5000,
    })
    expect(move).toHaveBeenCalledTimes(1)

    await typeTitle('Something else entirely')
    await waitFor(
      () =>
        expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
          'Something else entirely',
        ),
      { timeout: 5000 },
    )
    await waitForWriteLanded()
    expect(address().textContent).toMatch(/\/d\/checkout-architecture$/)
    const held = await store.listDocuments({ workspaceId: getBrowserWorkspaceId() })
    expect(held.map((entry) => entry.path)).toEqual(['checkout-architecture'])
    expect(move).toHaveBeenCalledTimes(1)
  })
})
