// One click selects and a double-click or Enter opens, on every surface that
// lists documents — real click/dblclick/tap sequences, since the order of
// native events is what jsdom cannot prove.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { STORAGE_KEY } from '../../lib/recent-documents.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

const PREVIEW_EMPTY = 'Select a document to preview its content.'
const entries = [
  { documentId: 'd1', path: 'meeting-notes', name: 'Meeting notes', kind: 'markdown' as const },
  { documentId: 'd2', path: 'roadmap', name: 'Roadmap', kind: 'spatial' as const },
  ...Array.from({ length: 10 }, (_, i) => ({
    documentId: `f${i}`,
    path: `filler-${i}`,
    name: `Filler ${i}`,
    kind: 'markdown' as const,
  })),
]

const realMatchMedia = window.matchMedia
// A fresh scope per test: the search box refills from its scope's memory.
let scopeCount = 0
let scope = 'space'
let coarse = false
beforeEach(() => {
  coarse = false
  scope = `space-${scopeCount++}`
  localStorage.removeItem(STORAGE_KEY)
  window.matchMedia = (query: string) =>
    query === '(pointer: coarse)'
      ? ({
          matches: coarse,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        } as unknown as MediaQueryList)
      : realMatchMedia.call(window, query)
})
afterEach(() => {
  cleanup()
  localStorage.removeItem(STORAGE_KEY)
  window.matchMedia = realMatchMedia
})

function renderPanel(onOpenDocument: (path: string) => void, memoryScope = scope) {
  const source = fakeFilesSource({ listDocuments: async () => entries })
  render(
    <WorkspaceFilesPanel
      source={source}
      memoryScope={memoryScope}
      onOpenDocument={onOpenDocument}
    />,
  )
}

async function gridCard(name: string) {
  const grid = await screen.findByTestId('folder-contents')
  const title = await within(grid).findByText(name)
  return title.closest('button') as HTMLElement
}

/** Puts a document in the Recent lane by opening it, then remounts. */
async function renderWithRecent(onOpenDocument: (path: string) => void) {
  renderPanel(() => {})
  await userEvent.dblClick(await gridCard('Roadmap'))
  cleanup()
  renderPanel(onOpenDocument)
  const lane = await screen.findByTestId('recent-lane')
  return within(lane).getByRole('button', { name: /Roadmap/ })
}

describe('Recent lane: click selects, double-click or Enter opens', () => {
  it('a single click selects and does not open', async () => {
    const open = vi.fn()
    const tile = await renderWithRecent(open)
    await userEvent.click(tile)
    expect(open).not.toHaveBeenCalled()
    expect(screen.queryByText(PREVIEW_EMPTY)).toBeNull()
  })

  it('a double-click opens exactly once', async () => {
    const open = vi.fn()
    const tile = await renderWithRecent(open)
    await userEvent.dblClick(tile)
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith('roadmap')
  })

  it('Enter opens once without selecting', async () => {
    const open = vi.fn()
    const tile = await renderWithRecent(open)
    tile.focus()
    await userEvent.keyboard('{Enter}')
    expect(open).toHaveBeenCalledTimes(1)
    expect(screen.getByText(PREVIEW_EMPTY)).toBeTruthy()
  })

  it('a tap on a coarse pointer opens', async () => {
    const open = vi.fn()
    const tile = await renderWithRecent(open)
    cleanup()
    coarse = true
    renderPanel(open)
    const lane = await screen.findByTestId('recent-lane')
    await userEvent.click(within(lane).getByRole('button', { name: /Roadmap/ }))
    expect(open).toHaveBeenCalledWith('roadmap')
    expect(tile).toBeTruthy()
  })
})

describe('search results: click selects, double-click or Enter opens', () => {
  async function searchResult(open: (path: string) => void) {
    renderPanel(open)
    await gridCard('Roadmap')
    await userEvent.type(screen.getByLabelText('Search documents'), 'roadmap')
    return await screen.findByRole('button', { name: /Roadmap/ })
  }

  it('a single click selects and does not open', async () => {
    const open = vi.fn()
    await userEvent.click(await searchResult(open))
    expect(open).not.toHaveBeenCalled()
    expect(screen.queryByText(PREVIEW_EMPTY)).toBeNull()
  })

  it('a double-click opens once', async () => {
    const open = vi.fn()
    await userEvent.dblClick(await searchResult(open))
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith('roadmap')
  })

  it('a tap on a coarse pointer opens', async () => {
    coarse = true
    const open = vi.fn()
    await userEvent.click(await searchResult(open))
    expect(open).toHaveBeenCalledWith('roadmap')
  })

  it('keeps the query in the box after opening a result and coming back', async () => {
    const open = vi.fn()
    await userEvent.dblClick(await searchResult(open))
    cleanup()
    renderPanel(open)
    await waitFor(() =>
      expect((screen.getByLabelText('Search documents') as HTMLInputElement).value).toBe('roadmap'),
    )
  })
})

describe('grid cards: click selects, double-click opens, tap opens on coarse', () => {
  it('a single click selects without opening', async () => {
    const open = vi.fn()
    renderPanel(open)
    await userEvent.click(await gridCard('Roadmap'))
    expect(open).not.toHaveBeenCalled()
    expect(screen.queryByText(PREVIEW_EMPTY)).toBeNull()
  })

  it('a tap on a coarse pointer opens', async () => {
    coarse = true
    const open = vi.fn()
    renderPanel(open)
    await userEvent.click(await gridCard('Roadmap'))
    expect(open).toHaveBeenCalledWith('roadmap')
  })
})
