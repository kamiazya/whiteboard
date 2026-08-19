import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IndexedDBStore } from '../lib/browser-local-store.js'
import { BrowserLocalDocumentPage } from './BrowserLocalDocumentPage.js'
// Real app styles so a11y/focus assertions run against the shipped geometry.
import '../index.css'

// The page reads/writes the canvas id through the router, so it needs a router
// in scope exactly as it has one in main.tsx.
function render(ui: ReactElement) {
  return rtlRender(
    // Pages fill their allotted height (h-full) — the app shell owns the
    // viewport in production, so tests supply the equivalent sized parent.
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </div>,
  )
}

async function clearDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('whiteboard')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

async function renderLoaded(store = new IndexedDBStore()) {
  render(<BrowserLocalDocumentPage store={store} />)
  await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(), {
    timeout: 5000,
  })
  return store
}

// Open the canvas row's operations kebab, pick "Delete", and wait
// for the confirmation dialog to appear.
async function openDeleteDialog(): Promise<HTMLElement> {
  // The kebab lives in the (lazy) WorkspaceTopBar's merged row — a
  // synchronous lookup races the chunk fetch.
  const kebab = await screen.findByRole('button', { name: 'More actions' })
  fireEvent.pointerDown(kebab, { button: 0, ctrlKey: false })
  const item = await screen.findByRole('menuitem', { name: /^delete$/i })
  fireEvent.pointerUp(item)
  return screen.findByRole('alertdialog', undefined, { timeout: 5000 })
}

describe('BrowserLocalDocumentPage delete confirmation (browser — real IndexedDB)', () => {
  beforeEach(async () => {
    await clearDb()
  })

  afterEach(() => {
    cleanup()
  })

  it('opening the delete dialog does not delete the canvas yet', async () => {
    const store = await renderLoaded()
    await openDeleteDialog()

    // Not yet deleted: the cleanup-completed screen has not been shown, and the
    // canvas row is still present in the store.
    expect(screen.queryByTestId('cleanup-completed')).toBeNull()
    const list = await store.listDocuments()
    expect(list.length).toBeGreaterThan(0)
  })

  it('confirming deletion shows the cleanup-completed view and removes the canvas row', async () => {
    const store = await renderLoaded()
    const beforeIds = (await store.listDocuments()).map((c) => c.documentId)
    expect(beforeIds.length).toBeGreaterThan(0)

    const dialog = await openDeleteDialog()
    within(dialog)
      .getByRole('button', { name: /^delete$/i })
      .click()

    await waitFor(() => expect(screen.getByTestId('cleanup-completed')).toBeInTheDocument(), {
      timeout: 5000,
    })
    const afterIds = (await store.listDocuments()).map((c) => c.documentId)
    for (const id of beforeIds) {
      expect(afterIds).not.toContain(id)
    }
  })

  it('cancelling via the Cancel button keeps the canvas intact', async () => {
    await renderLoaded()
    const dialog = await openDeleteDialog()
    within(dialog)
      .getByRole('button', { name: /cancel/i })
      .click()

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull(), { timeout: 5000 })
    expect(screen.queryByTestId('cleanup-completed')).toBeNull()
    expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Saved' })).toBeInTheDocument()
  })

  it('cancelling via Escape keeps the canvas intact', async () => {
    await renderLoaded()
    const dialog = await openDeleteDialog()
    fireEvent.keyDown(dialog, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull(), { timeout: 5000 })
    expect(screen.queryByTestId('cleanup-completed')).toBeNull()
    expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument()
  })

  it('dialog exposes an accessible name and description tied to the destructive action', async () => {
    await renderLoaded()
    const dialog = await openDeleteDialog()

    expect(dialog).toHaveAccessibleName('Delete this canvas?')
    expect(dialog).toHaveAccessibleDescription(/permanently removes the canvas.*cannot be undone/i)
  })

  it('focus moves into the dialog on open and returns to the kebab on close', async () => {
    await renderLoaded()
    const dialog = await openDeleteDialog()
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true), {
      timeout: 5000,
    })

    within(dialog)
      .getByRole('button', { name: /cancel/i })
      .click()
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull(), { timeout: 5000 })
    // The menu item that opened the dialog is long unmounted — focus must
    // land back on the kebab, not fall to <body>.
    // The kebab lives in the (lazy) WorkspaceTopBar's merged row — a
    // synchronous lookup races the chunk fetch.
    const kebab = await screen.findByRole('button', { name: 'More actions' })
    await waitFor(() => expect(document.activeElement).toBe(kebab), { timeout: 5000 })
  })

  it('confirming delete while a save is pending flushes and deletes exactly once', async () => {
    let store = await renderLoaded()
    const beforeIds = (await store.listDocuments()).map((c) => c.documentId)

    // Put the header persistence state into "pending" by renaming, then
    // immediately open+confirm the delete dialog before the debounce fires.
    //
    // In real-browser mode, opening WorkspaceTopBar's "Canvas actions" menu
    // for the first time after several prior AlertDialogs have opened and
    // closed in this file occasionally does not register on the first
    // pointerdown — a Radix dismissable-layer/testing-tooling quirk (never
    // reproduces in jsdom) rather than a product defect. A full fresh
    // remount clears it reliably, so retry with one on failure.
    let renameItem: HTMLElement | undefined
    for (let attempt = 0; attempt < 8 && !renameItem; attempt++) {
      if (attempt > 0) {
        cleanup()
        store = await renderLoaded()
      }
      // A stale tree can briefly coexist with a fresh one across a retry's
      // cleanup+remount; querying "all" and taking the most-recently-mounted
      // match sidesteps a transient multiple-elements error instead of
      // failing the whole retry loop on it.
      const allCanvasActions = await waitFor(() => screen.getAllByLabelText('Canvas actions'), {
        timeout: 5000,
      })
      const canvasActions = allCanvasActions[allCanvasActions.length - 1]!
      fireEvent.pointerDown(canvasActions, { button: 0, ctrlKey: false })
      try {
        const allRenameItems = await waitFor(() => screen.getAllByText('Rename canvas'), {
          timeout: 1500,
        })
        renameItem = allRenameItems[allRenameItems.length - 1]!
      } catch {
        // retry with a fresh remount
      }
    }
    if (!renameItem) throw new Error('Canvas actions dropdown never opened after retries')
    fireEvent.pointerUp(renameItem)
    const titleInput = await screen.findByRole(
      'textbox',
      { name: /canvas title/i },
      { timeout: 3000 },
    )
    titleInput.focus()
    fireEvent.change(titleInput, { target: { value: 'Pending edit' } })

    const dialog = await openDeleteDialog()
    within(dialog)
      .getByRole('button', { name: /^delete$/i })
      .click()

    await waitFor(() => expect(screen.getByTestId('cleanup-completed')).toBeInTheDocument(), {
      timeout: 5000,
    })
    const afterIds = (await store.listDocuments()).map((c) => c.documentId)
    for (const id of beforeIds) {
      expect(afterIds).not.toContain(id)
    }
  })
})
