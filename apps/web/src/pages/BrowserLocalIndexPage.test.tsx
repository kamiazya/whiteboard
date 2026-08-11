// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryStore } from '../lib/browser-local-store.js'
import type { CanvasSnapshot } from '../lib/whiteboard-client.js'
import { BrowserLocalIndexPage } from './BrowserLocalIndexPage.js'

afterEach(cleanup)

async function seededStore(snapshots: CanvasSnapshot[]) {
  const store = new MemoryStore()
  for (const s of snapshots) await store.save(s)
  return store
}

function renderPage(store: MemoryStore) {
  const onOpenCanvas = vi.fn()
  // React delegates events to the root; Radix portals render into
  // document.body, so the body must be the React root for portal events.
  const utils = render(<BrowserLocalIndexPage store={store} onOpenCanvas={onOpenCanvas} />, {
    container: document.body,
  })
  return { onOpenCanvas, ...utils }
}

describe('BrowserLocalIndexPage', () => {
  it('lists snapshots most-recent first with name, derived display slug, and kind marker', async () => {
    const store = await seededStore([
      { id: 'id-a', name: 'Trip Plan', updatedAt: '2026-08-01T00:00:00Z', kind: 'spatial' },
      { id: 'id-b', name: 'Meeting Notes', updatedAt: '2026-08-10T00:00:00Z', kind: 'markdown' },
    ])
    renderPage(store)

    const cards = await screen.findAllByTestId('canvas-list-card')
    expect(cards).toHaveLength(2)
    expect(within(cards[0]!).getByText('Meeting Notes')).toBeTruthy()
    expect(within(cards[0]!).getByTestId('canvas-secondary').textContent).toBe('meeting-notes')
    expect(within(cards[0]!).getByText(/markdown/i)).toBeTruthy()
    expect(within(cards[1]!).getByText('Trip Plan')).toBeTruthy()
    expect(within(cards[1]!).getByTestId('canvas-secondary').textContent).toBe('trip-plan')
    expect(within(cards[1]!).queryByText(/markdown/i)).toBeNull()
  })

  it('opens a canvas by its id on card click', async () => {
    const store = await seededStore([
      { id: 'id-a', name: 'Solo', updatedAt: '2026-08-01T00:00:00Z', kind: 'spatial' },
    ])
    const { onOpenCanvas } = renderPage(store)

    fireEvent.click((await screen.findAllByTestId('canvas-list-card'))[0]!)
    expect(onOpenCanvas).toHaveBeenCalledWith('id-a')
  })

  it('creates a markdown canvas from the + menu, repoints the default, and opens it', async () => {
    const store = await seededStore([
      { id: 'id-a', name: 'Existing', updatedAt: '2026-08-01T00:00:00Z', kind: 'spatial' },
    ])
    const { onOpenCanvas } = renderPage(store)
    await screen.findAllByTestId('canvas-list-card')

    fireEvent.pointerDown(screen.getByRole('button', { name: 'New canvas' }), {
      button: 0,
      ctrlKey: false,
    })
    fireEvent.pointerUp(await screen.findByRole('menuitem', { name: 'New markdown note' }))

    await waitFor(() => expect(onOpenCanvas).toHaveBeenCalledTimes(1))
    const newId = onOpenCanvas.mock.calls[0]![0] as string
    expect(newId).not.toBe('id-a')
    const all = await store.listCanvases()
    const created = all.find((s) => s.id === newId)
    expect(created?.kind).toBe('markdown')
    expect(await store.getDefaultCanvasId()).toBe(newId)
  })

  it('empty store shows the empty state whose action creates a spatial canvas', async () => {
    const store = new MemoryStore()
    const { onOpenCanvas } = renderPage(store)

    fireEvent.click(await screen.findByRole('button', { name: /create a canvas/i }))

    await waitFor(() => expect(onOpenCanvas).toHaveBeenCalledTimes(1))
    const newId = onOpenCanvas.mock.calls[0]![0] as string
    const created = (await store.listCanvases()).find((s) => s.id === newId)
    expect(created?.kind).toBe('spatial')
  })

  it('creates exactly one canvas for two presses inside a single tick', async () => {
    // Pins the createDisabled wiring: React flushes `creating` before a
    // second click can dispatch on the now-disabled button.
    const store = new MemoryStore()
    const { onOpenCanvas } = renderPage(store)
    const button = await screen.findByRole('button', { name: /create a canvas/i })

    fireEvent.click(button)
    fireEvent.click(button)

    await waitFor(() => expect(onOpenCanvas).toHaveBeenCalledTimes(1))
    expect(await store.listCanvases()).toHaveLength(1)
  })

  it('keeps a create entry point when the list fails to load', async () => {
    // A failed listCanvases must not dead-end the page: the create path
    // does not need the list (fresh id + save), and success navigates away.
    const store = new MemoryStore()
    store.listCanvases = () => Promise.reject(new Error('idb blocked'))
    const { onOpenCanvas } = renderPage(store)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Failed to load canvases from this browser.')
    fireEvent.click(screen.getByRole('button', { name: 'Create a canvas' }))
    await waitFor(() => expect(onOpenCanvas).toHaveBeenCalledTimes(1))
  })

  it('surfaces a create failure and re-enables the create action', async () => {
    const store = new MemoryStore()
    store.save = () => Promise.reject(new Error('quota exceeded'))
    const { onOpenCanvas } = renderPage(store)

    const button = await screen.findByRole('button', { name: /create a canvas/i })
    fireEvent.click(button)

    const alert = await screen.findByRole('alert')
    // Fixed copy — never the raw error text.
    expect(alert.textContent).toBe('Failed to create a canvas in this browser.')
    expect(onOpenCanvas).not.toHaveBeenCalled()
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
  })

  it('suffixes colliding display slugs instead of repeating them', async () => {
    const store = await seededStore([
      { id: 'id-a', name: 'Notes', updatedAt: '2026-08-02T00:00:00Z', kind: 'spatial' },
      { id: 'id-b', name: 'Notes', updatedAt: '2026-08-01T00:00:00Z', kind: 'spatial' },
    ])
    renderPage(store)

    const cards = await screen.findAllByTestId('canvas-list-card')
    const secondaries = cards.map((c) => within(c).getByTestId('canvas-secondary').textContent)
    expect(new Set(secondaries).size).toBe(2)
    expect(secondaries).toContain('notes')
    expect(secondaries).toContain('notes-2')
  })
})
