// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

// Selection mode, whose one verb is bulk delete (owner decision 2026-09-05:
// "bulk delete only" — the trash already provides the undo, so the mode can
// be judged on a single verb rather than a family of them).
//
// Entered from the card menu, which is the object surface both pointers
// already reach: right-click on a desktop, long-press on a touch screen.
// That is also where Finder and iOS Files put it.

afterEach(cleanup)

const entries = [
  { documentId: 'd1', path: 'meeting-notes', name: 'Meeting notes', kind: 'markdown' as const },
  { documentId: 'd2', path: 'roadmap', name: 'Roadmap', kind: 'spatial' as const },
  { documentId: 'd3', path: 'tokens', name: 'Tokens', kind: 'markdown' as const },
]

const realMatchMedia = window.matchMedia
beforeEach(() => {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList
})
afterEach(() => {
  window.matchMedia = realMatchMedia
})

function renderPanel(
  overrides: {
    onOpenDocument?: (path: string) => void
    onRequestDeleteMany?: (paths: readonly string[]) => void
    onRequestDelete?: (path: string, displayName: string) => void
  } = {},
) {
  render(
    <WorkspaceFilesPanel
      source={fakeFilesSource({ listDocuments: () => Promise.resolve(entries) })}
      {...overrides}
    />,
  )
}

async function cardButton(name: string) {
  const title = (await screen.findAllByTestId('card-title')).find(
    (each) => each.textContent === name,
  )
  if (title === undefined) throw new Error(`no card titled ${name}`)
  return title.closest('button') as HTMLElement
}

async function enterSelection(name: string) {
  const card = await cardButton(name)
  fireEvent.contextMenu(card, { clientX: 30, clientY: 30 })
  const menu = await screen.findByRole('menu', { name: 'Document actions' })
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Select' }))
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  return card
}

const bar = () => screen.queryByTestId('selection-bar')

describe('selection mode', () => {
  it('offers Select only where a bulk delete can actually happen', async () => {
    renderPanel({})

    fireEvent.contextMenu(await cardButton('Roadmap'), { clientX: 5, clientY: 5 })
    const menu = await screen.findByRole('menu', { name: 'Document actions' })

    expect(within(menu).queryByRole('menuitem', { name: 'Select' })).toBeNull()
  })

  it('starts with the card the menu was opened on already selected', async () => {
    renderPanel({ onRequestDeleteMany: vi.fn() })

    const card = await enterSelection('Roadmap')

    expect(card.getAttribute('aria-pressed')).toBe('true')
    expect(bar()?.textContent).toContain('1 selected')
  })

  it('toggles a card on click instead of opening it', async () => {
    const onOpenDocument = vi.fn()
    renderPanel({ onOpenDocument, onRequestDeleteMany: vi.fn() })
    await enterSelection('Roadmap')

    const other = await cardButton('Tokens')
    fireEvent.click(other, { detail: 1 })

    expect(other.getAttribute('aria-pressed')).toBe('true')
    expect(onOpenDocument).not.toHaveBeenCalled()
    await waitFor(() => expect(bar()?.textContent).toContain('2 selected'))
  })

  it('does not open on a double-click while a selection is live', async () => {
    const onOpenDocument = vi.fn()
    renderPanel({ onOpenDocument, onRequestDeleteMany: vi.fn() })
    await enterSelection('Roadmap')

    // A SECOND card, so the mode is unambiguously still live: clicking the
    // only selected card deselects it and ends the mode, after which a
    // double-click opens correctly and the test would assert nothing. It
    // was written that way first, and failed for exactly that reason.
    const other = await cardButton('Tokens')
    fireEvent.click(other, { detail: 1 })
    await waitFor(() => expect(bar()?.textContent).toContain('2 selected'))
    fireEvent.doubleClick(other)

    expect(onOpenDocument).not.toHaveBeenCalled()
  })

  it('leaves selection mode when the last card is deselected', async () => {
    renderPanel({ onRequestDeleteMany: vi.fn() })
    const card = await enterSelection('Roadmap')

    fireEvent.click(card, { detail: 1 })

    await waitFor(() => expect(bar()).toBeNull())
    expect(card.getAttribute('aria-pressed')).toBeNull()
  })

  it('Cancel clears the selection without deleting anything', async () => {
    const onRequestDeleteMany = vi.fn()
    renderPanel({ onRequestDeleteMany })
    await enterSelection('Roadmap')

    fireEvent.click(within(bar() as HTMLElement).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(bar()).toBeNull())
    expect(onRequestDeleteMany).not.toHaveBeenCalled()
  })

  it('raises one request carrying every selected path, in the order shown', async () => {
    const onRequestDeleteMany = vi.fn()
    renderPanel({ onRequestDeleteMany })
    await enterSelection('Tokens')
    fireEvent.click(await cardButton('Meeting notes'), { detail: 1 })

    fireEvent.click(within(bar() as HTMLElement).getByRole('button', { name: 'Delete' }))

    expect(onRequestDeleteMany).toHaveBeenCalledTimes(1)
    expect(onRequestDeleteMany).toHaveBeenCalledWith(['meeting-notes', 'tokens'])
  })

  it('routes a single selection through the singular delete, which names the document', async () => {
    // Not a plural dialog reading "Delete 1 document?": the singular path is
    // already built and says which one, so the mode borrows it rather than
    // growing a second confirmation that agrees in number.
    const onRequestDelete = vi.fn()
    const onRequestDeleteMany = vi.fn()
    renderPanel({ onRequestDelete, onRequestDeleteMany })
    await enterSelection('Roadmap')

    fireEvent.click(within(bar() as HTMLElement).getByRole('button', { name: 'Delete' }))

    expect(onRequestDeleteMany).not.toHaveBeenCalled()
    expect(onRequestDelete).toHaveBeenCalledWith('roadmap', 'Roadmap', 'spatial')
  })

  it('keeps the selection while the confirmation is up, so a cancel returns to it', async () => {
    const onRequestDeleteMany = vi.fn()
    renderPanel({ onRequestDeleteMany })
    await enterSelection('Tokens')
    fireEvent.click(await cardButton('Meeting notes'), { detail: 1 })

    fireEvent.click(within(bar() as HTMLElement).getByRole('button', { name: 'Delete' }))

    // The page owns the dialog; from here the request has been raised and
    // nothing has been deleted yet.
    expect(bar()?.textContent).toContain('2 selected')
  })

  it('drops a selected path that has left the listing', async () => {
    // A concurrent delete, seen from here: the same panel re-reads and the
    // path it had selected is simply not in the answer.
    let rows = entries
    const source = fakeFilesSource({ listDocuments: () => Promise.resolve(rows) })
    const view = render(
      <WorkspaceFilesPanel source={source} onRequestDeleteMany={vi.fn()} revision={1} />,
    )
    await enterSelection('Roadmap')
    fireEvent.click(await cardButton('Tokens'), { detail: 1 })
    await waitFor(() => expect(bar()?.textContent).toContain('2 selected'))

    rows = entries.filter((each) => each.path !== 'tokens')
    view.rerender(
      <WorkspaceFilesPanel source={source} onRequestDeleteMany={vi.fn()} revision={2} />,
    )

    await waitFor(() => expect(screen.queryAllByTestId('card-title')).toHaveLength(2))
    await waitFor(() => expect(bar()?.textContent).toContain('1 selected'))
  })
})
