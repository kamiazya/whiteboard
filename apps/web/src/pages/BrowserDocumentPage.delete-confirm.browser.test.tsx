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
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { listLocalDocuments } from '../lib/local-document-summary.js'
import { BrowserDocumentPage } from './BrowserDocumentPage.js'
// Real app styles so a11y/focus assertions run against the shipped geometry.
import '../index.css'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedIdbDocument } from '../test-utils/seed-idb-document.js'

const ISOLATED_DB = claimIsolatedWhiteboardDb('browserdocumentpage-delete-confirm')

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
    const req = indexedDB.deleteDatabase(ISOLATED_DB)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

async function renderLoaded(
  store: IdbDocumentIndex = new IdbDocumentIndex(),
): Promise<IdbDocumentIndex> {
  render(<BrowserDocumentPage store={store} />)
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

describe('BrowserDocumentPage delete confirmation (browser — real IndexedDB)', () => {
  beforeEach(async () => {
    await clearDb()
  })

  afterEach(() => {
    cleanup()
  })

  it('a markdown note names itself in the dialog: note, not canvas', async () => {
    // The kind-aware copy's whole point on this page — the markdown branch
    // must not inherit the spatial wording.
    const store = new IdbDocumentIndex()
    await seedIdbDocument(store, {
      path: 'meeting-notes',
      name: 'Meeting notes',
      kind: 'markdown',
      makeDefault: true,
    })
    render(<BrowserDocumentPage store={store} />)
    await screen.findByRole('button', { name: 'More actions' }, { timeout: 5000 })

    const dialog = await openDeleteDialog()
    expect(dialog).toHaveAccessibleName('Delete this note?')
    // The delete EVACUATES to the trash (loro-workspace-document-index's
    // "EVACUATE FIRST"), and the Trash section offers Restore — so a dialog
    // claiming the opposite talks a reader out of a safe action.
    expect(dialog).toHaveAccessibleDescription(/Trash/i)
    expect(dialog).toHaveAccessibleDescription(/restore/i)
    expect(dialog).not.toHaveAccessibleDescription(/no undo|cannot be undone/i)
  })

  it('opening the delete dialog does not delete the canvas yet', async () => {
    const store = await renderLoaded()
    await openDeleteDialog()

    // Not yet deleted: the cleanup-completed screen has not been shown, and the
    // canvas row is still present in the store.
    expect(screen.queryByTestId('cleanup-completed')).toBeNull()
    const list = await listLocalDocuments(store)
    expect(list.length).toBeGreaterThan(0)
  })

  it('confirming deletion shows the cleanup-completed view and removes the canvas row', async () => {
    const store = await renderLoaded()
    const beforeIds = (await listLocalDocuments(store)).map((c) => c.documentId)
    expect(beforeIds.length).toBeGreaterThan(0)

    const dialog = await openDeleteDialog()
    within(dialog)
      .getByRole('button', { name: /^delete$/i })
      .click()

    await waitFor(() => expect(screen.getByTestId('cleanup-completed')).toBeInTheDocument(), {
      timeout: 5000,
    })
    const afterIds = (await listLocalDocuments(store)).map((c) => c.documentId)
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
    // No save state is drawn; the facts stay published, hidden, and untouched.
    expect(screen.getByTestId('persistence-state').getAttribute('data-save-state')).toBe('saved')
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
    expect(dialog).toHaveAccessibleDescription(/Trash/i)
    expect(dialog).not.toHaveAccessibleDescription(/no undo|cannot be undone/i)
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
    const store = await renderLoaded()
    const beforeIds = (await listLocalDocuments(store)).map((c) => c.documentId)

    // Put the header persistence state into "pending" by renaming, then
    // immediately open+confirm the delete dialog before the debounce fires.
    // The title field is always mounted, so there is no menu to open first.
    const titleInput = await screen.findByRole('textbox', { name: /^title$/i }, { timeout: 5000 })
    titleInput.focus()
    fireEvent.change(titleInput, { target: { value: 'Pending edit' } })

    const dialog = await openDeleteDialog()
    within(dialog)
      .getByRole('button', { name: /^delete$/i })
      .click()

    await waitFor(() => expect(screen.getByTestId('cleanup-completed')).toBeInTheDocument(), {
      timeout: 5000,
    })
    const afterIds = (await listLocalDocuments(store)).map((c) => c.documentId)
    for (const id of beforeIds) {
      expect(afterIds).not.toContain(id)
    }
  })
})
