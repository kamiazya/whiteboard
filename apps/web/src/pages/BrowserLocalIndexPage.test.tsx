// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_WORKSPACE_ID, MemoryStore } from '../lib/browser-local-store.js'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import { BrowserLocalIndexPage } from './BrowserLocalIndexPage.js'

afterEach(cleanup)

async function seededStore(snapshots: DocumentSnapshot[]) {
  const store = new MemoryStore()
  for (const s of snapshots) await store.save(s)
  return store
}

function renderPage(store: MemoryStore) {
  const onOpenDocument = vi.fn()
  // React delegates events to the root; Radix portals render into
  // document.body, so the body must be the React root for portal events.
  const utils = render(
    <MemoryRouter initialEntries={['/']}>
      <BrowserLocalIndexPage store={store} onOpenDocument={onOpenDocument} />
    </MemoryRouter>,
    {
      container: document.body,
    },
  )
  return { onOpenDocument, ...utils }
}

describe('BrowserLocalIndexPage', () => {
  it('lists snapshots most-recent first with name and kind marker', async () => {
    const store = await seededStore([
      {
        documentId: '0CFJNRVY147ADGKPSWZ258BEHM',
        workspaceId: 'local',
        path: 'trip-plan',
        name: 'Trip Plan',
        updatedAt: '2026-08-01T00:00:00Z',
        kind: 'spatial',
      },
      {
        documentId: '0KPSWZ258BEHMQTX0369CFJNRV',
        workspaceId: 'local',
        path: 'meeting-notes',
        name: 'Meeting Notes',
        updatedAt: '2026-08-10T00:00:00Z',
        kind: 'markdown',
      },
    ])
    renderPage(store)

    const cards = await screen.findAllByTestId('document-list-card')
    expect(cards).toHaveLength(2)
    expect(within(cards[0]!).getByText('Meeting Notes')).toBeTruthy()
    expect(within(cards[0]!).getByText(/markdown/i)).toBeTruthy()
    expect(within(cards[1]!).getByText('Trip Plan')).toBeTruthy()
    expect(within(cards[1]!).queryByText(/markdown/i)).toBeNull()
  })

  it('opens a canvas by its path on card click', async () => {
    const store = await seededStore([
      {
        documentId: '0CFJNRVY147ADGKPSWZ258BEHM',
        workspaceId: 'local',
        path: 'solo',
        name: 'Solo',
        updatedAt: '2026-08-01T00:00:00Z',
        kind: 'spatial',
      },
    ])
    const { onOpenDocument } = renderPage(store)

    fireEvent.click((await screen.findAllByTestId('document-list-card'))[0]!)
    expect(onOpenDocument).toHaveBeenCalledWith('solo')
  })

  it('creates a markdown canvas from the + menu, repoints the default, and opens it', async () => {
    const store = await seededStore([
      {
        documentId: '0CFJNRVY147ADGKPSWZ258BEHM',
        workspaceId: 'local',
        path: 'existing',
        name: 'Existing',
        updatedAt: '2026-08-01T00:00:00Z',
        kind: 'spatial',
      },
    ])
    const { onOpenDocument } = renderPage(store)
    await screen.findAllByTestId('document-list-card')

    fireEvent.pointerDown(screen.getByRole('button', { name: 'New canvas' }), {
      button: 0,
      ctrlKey: false,
    })
    fireEvent.pointerUp(await screen.findByRole('menuitem', { name: 'New markdown note' }))

    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledTimes(1))
    const newPath = onOpenDocument.mock.calls[0]![0] as string
    expect(newPath).not.toBe('existing')
    const all = await store.listDocuments()
    const created = all.find((s) => s.path === newPath)
    expect(created?.kind).toBe('markdown')
    // The default pointer is by id, the callback is by path — the two
    // addresses have to agree on one document.
    expect(await store.getDefaultDocumentId()).toBe(created?.documentId)
  })

  it('empty store shows the empty state whose action creates a spatial canvas', async () => {
    const store = new MemoryStore()
    const { onOpenDocument } = renderPage(store)

    fireEvent.click(await screen.findByRole('button', { name: /create a canvas/i }))

    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledTimes(1))
    const newPath = onOpenDocument.mock.calls[0]![0] as string
    const created = (await store.listDocuments()).find((s) => s.path === newPath)
    expect(created?.kind).toBe('spatial')
  })

  it('creates exactly one canvas for two presses inside a single tick', async () => {
    // Pins the createDisabled wiring: React flushes `creating` before a
    // second click can dispatch on the now-disabled button.
    const store = new MemoryStore()
    const { onOpenDocument } = renderPage(store)
    const button = await screen.findByRole('button', { name: /create a canvas/i })

    fireEvent.click(button)
    fireEvent.click(button)

    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledTimes(1))
    expect(await store.listDocuments()).toHaveLength(1)
  })

  it('keeps a create entry point when the list fails to load', async () => {
    // A failed listDocuments must not dead-end the page: the create path
    // does not need the list (fresh id + save), and success navigates away.
    const store = new MemoryStore()
    store.listDocuments = () => Promise.reject(new Error('idb blocked'))
    const { onOpenDocument } = renderPage(store)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Failed to load documents from this browser.')
    fireEvent.click(screen.getByRole('button', { name: 'Create a canvas' }))
    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledTimes(1))
  })

  it('surfaces a create failure and re-enables the create action', async () => {
    const store = new MemoryStore()
    store.save = () => Promise.reject(new Error('quota exceeded'))
    const { onOpenDocument } = renderPage(store)

    const button = await screen.findByRole('button', { name: /create a canvas/i })
    fireEvent.click(button)

    const alert = await screen.findByRole('alert')
    // Fixed copy — never the raw error text.
    expect(alert.textContent).toBe('Failed to create a canvas in this browser.')
    expect(onOpenDocument).not.toHaveBeenCalled()
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
  })

  it('Delete opens a dialog naming the canvas; Cancel removes nothing', async () => {
    const store = await seededStore([
      {
        documentId: '0CFJNRVY147ADGKPSWZ258BEHM',
        workspaceId: 'local',
        path: 'keep-me',
        name: 'Keep Me',
        updatedAt: '2026-08-01T00:00:00Z',
        kind: 'spatial',
      },
    ])
    renderPage(store)
    await screen.findAllByTestId('document-list-card')

    fireEvent.click(screen.getByRole('button', { name: 'Delete Keep Me' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/Delete "Keep Me"\?/)).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(await store.listDocuments()).toHaveLength(1)
    expect(screen.getAllByTestId('document-list-card')).toHaveLength(1)
  })

  it('confirming Delete removes the canvas; deleting the last one returns the empty state', async () => {
    const store = await seededStore([
      {
        documentId: '0CFJNRVY147ADGKPSWZ258BEHM',
        workspaceId: 'local',
        path: 'doomed',
        name: 'Doomed',
        updatedAt: '2026-08-01T00:00:00Z',
        kind: 'spatial',
      },
    ])
    const { onOpenDocument } = renderPage(store)
    await screen.findAllByTestId('document-list-card')

    fireEvent.click(screen.getByRole('button', { name: 'Delete Doomed' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(await store.listDocuments()).toHaveLength(0)
    expect(await screen.findByText('No documents yet')).toBeTruthy()
    // The delete flow must never open the canvas.
    expect(onOpenDocument).not.toHaveBeenCalled()
  })

  it('a failed delete shows the fixed error in the dialog, which stays open, and Cancel clears it', async () => {
    const store = await seededStore([
      {
        documentId: '0CFJNRVY147ADGKPSWZ258BEHM',
        workspaceId: 'local',
        path: 'sticky',
        name: 'Sticky',
        updatedAt: '2026-08-01T00:00:00Z',
        kind: 'spatial',
      },
    ])
    store.removeDocument = () => Promise.reject(new Error('quota exceeded'))
    renderPage(store)
    await screen.findAllByTestId('document-list-card')

    fireEvent.click(screen.getByRole('button', { name: 'Delete Sticky' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    // Fixed copy — never the raw error text — and the dialog stays open.
    expect(
      await within(dialog).findByText('Failed to delete the canvas from this browser.'),
    ).toBeTruthy()
    expect(within(dialog).queryByText(/quota exceeded/)).toBeNull()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getAllByTestId('document-list-card')).toHaveLength(1)
  })

  it('shows each name over its own real path, which is never derived from that name', async () => {
    // Neither name carries ASCII, so a name-derived path would collapse both
    // to `untitled` / `untitled-2` — indistinguishable in the very column the
    // secondary line exists to distinguish. A local document now has a real
    // path exactly like a daemon one, and this is what shows it.
    const store = await seededStore([
      {
        documentId: '0CFJNRVY147ADGKPSWZ258BEHM',
        workspaceId: LOCAL_WORKSPACE_ID,
        path: 'diagrams/structure',
        name: '構成図',
        updatedAt: '2026-08-02T00:00:00Z',
        kind: 'spatial',
      },
      {
        documentId: '0KPSWZ258BEHMQTX0369CFJNRV',
        workspaceId: LOCAL_WORKSPACE_ID,
        path: 'notes/design',
        name: '設計メモ',
        updatedAt: '2026-08-01T00:00:00Z',
        kind: 'spatial',
      },
    ])
    renderPage(store)

    const cards = await screen.findAllByTestId('document-list-card')
    expect(within(cards[0]!).getByText('構成図')).toBeTruthy()
    expect(within(cards[0]!).getByTestId('canvas-secondary').textContent).toBe('diagrams/structure')
    expect(within(cards[1]!).getByText('設計メモ')).toBeTruthy()
    expect(within(cards[1]!).getByTestId('canvas-secondary').textContent).toBe('notes/design')
  })
})
