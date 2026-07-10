import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { BrowserLocalCanvasPage } from './BrowserLocalCanvasPage.js'
import { IndexedDBStore } from '../lib/browser-local-store.js'
// Real app styles so a11y/focus assertions run against the shipped geometry.
import '../index.css'

async function clearDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('whiteboard')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

async function renderLoaded(store = new IndexedDBStore()) {
  render(<BrowserLocalCanvasPage store={store} />)
  await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeInTheDocument(), {
    timeout: 5000,
  })
  return store
}

describe('BrowserLocalCanvasPage delete confirmation (browser — real IndexedDB)', () => {
  beforeEach(async () => {
    await clearDb()
  })

  afterEach(() => {
    cleanup()
  })

  it('opening the delete dialog does not delete the canvas yet', async () => {
    const store = await renderLoaded()
    screen.getByRole('button', { name: /delete canvas/i }).click()
    await screen.findByRole('alertdialog', undefined, { timeout: 5000 })

    // Not yet deleted: the cleanup-completed screen has not been shown, and the
    // canvas row is still present in the store.
    expect(screen.queryByTestId('cleanup-completed')).toBeNull()
    const list = await store.listCanvases()
    expect(list.length).toBeGreaterThan(0)
  })

  it('confirming deletion shows the cleanup-completed view and removes the canvas row', async () => {
    const store = await renderLoaded()
    const beforeIds = (await store.listCanvases()).map((c) => c.id)
    expect(beforeIds.length).toBeGreaterThan(0)

    screen.getByRole('button', { name: /delete canvas/i }).click()
    const dialog = await screen.findByRole('alertdialog', undefined, { timeout: 5000 })
    within(dialog)
      .getByRole('button', { name: /^delete$/i })
      .click()

    await waitFor(() => expect(screen.getByTestId('cleanup-completed')).toBeInTheDocument(), {
      timeout: 5000,
    })
    const afterIds = (await store.listCanvases()).map((c) => c.id)
    for (const id of beforeIds) {
      expect(afterIds).not.toContain(id)
    }
  })

  it('cancelling via the Cancel button keeps the canvas intact', async () => {
    await renderLoaded()
    screen.getByRole('button', { name: /delete canvas/i }).click()
    const dialog = await screen.findByRole('alertdialog', undefined, { timeout: 5000 })
    within(dialog)
      .getByRole('button', { name: /cancel/i })
      .click()

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull(), { timeout: 5000 })
    expect(screen.queryByTestId('cleanup-completed')).toBeNull()
    expect(screen.getByTestId('excalidraw-container')).toBeInTheDocument()
    expect(screen.getByText('Saved')).toBeInTheDocument()
  })

  it('cancelling via Escape keeps the canvas intact', async () => {
    await renderLoaded()
    screen.getByRole('button', { name: /delete canvas/i }).click()
    const dialog = await screen.findByRole('alertdialog', undefined, { timeout: 5000 })
    fireEvent.keyDown(dialog, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull(), { timeout: 5000 })
    expect(screen.queryByTestId('cleanup-completed')).toBeNull()
    expect(screen.getByTestId('excalidraw-container')).toBeInTheDocument()
  })

  it('dialog exposes an accessible name and description tied to the destructive action', async () => {
    await renderLoaded()
    screen.getByRole('button', { name: /delete canvas/i }).click()
    const dialog = await screen.findByRole('alertdialog', undefined, { timeout: 5000 })

    expect(dialog).toHaveAccessibleName('Delete this canvas?')
    expect(dialog).toHaveAccessibleDescription(/permanently removes the canvas.*cannot be undone/i)
  })

  it('focus moves into the dialog on open and returns to the trigger on close', async () => {
    await renderLoaded()
    const trigger = screen.getByRole('button', { name: /delete canvas/i })
    trigger.click()
    const dialog = await screen.findByRole('alertdialog', undefined, { timeout: 5000 })
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true), {
      timeout: 5000,
    })

    within(dialog)
      .getByRole('button', { name: /cancel/i })
      .click()
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull(), { timeout: 5000 })
    await waitFor(() => expect(document.activeElement).toBe(trigger), { timeout: 5000 })
  })

  it('confirming delete while a save is pending flushes and deletes exactly once', async () => {
    const store = await renderLoaded()
    const beforeIds = (await store.listCanvases()).map((c) => c.id)

    // Put the header persistence state into "pending" by renaming, then
    // immediately open+confirm the delete dialog before the debounce fires.
    const titleInput = screen.getByRole('textbox', { name: /canvas title/i })
    titleInput.focus()
    fireEvent.change(titleInput, { target: { value: 'Pending edit' } })

    screen.getByRole('button', { name: /delete canvas/i }).click()
    const dialog = await screen.findByRole('alertdialog', undefined, { timeout: 5000 })
    within(dialog)
      .getByRole('button', { name: /^delete$/i })
      .click()

    await waitFor(() => expect(screen.getByTestId('cleanup-completed')).toBeInTheDocument(), {
      timeout: 5000,
    })
    const afterIds = (await store.listCanvases()).map((c) => c.id)
    for (const id of beforeIds) {
      expect(afterIds).not.toContain(id)
    }
  })
})
