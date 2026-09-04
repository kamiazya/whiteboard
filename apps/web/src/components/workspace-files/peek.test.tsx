// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

// The peek (slice 3 of the 2026-09-05 picker redesign): with a tap opening
// the document and no preview column, a touch user had no way to LOOK at a
// document without committing to it. The object menu gains a Preview verb —
// only where the pane is absent, because where it renders, selection
// already answers the same question.

afterEach(cleanup)

const entries = [
  { documentId: 'd1', path: 'meeting-notes', name: 'Meeting notes', kind: 'markdown' as const },
]

const realMatchMedia = window.matchMedia
let coarse = false
const stubMql = (matches: boolean, media: string) =>
  ({
    matches,
    media,
    addEventListener: () => {},
    removeEventListener: () => {},
  }) as unknown as MediaQueryList
beforeEach(() => {
  coarse = false
  window.matchMedia = (query: string) =>
    query === '(pointer: coarse)'
      ? stubMql(coarse, query)
      : realMatchMedia
        ? realMatchMedia.call(window, query)
        : stubMql(false, query)
})
afterEach(() => {
  window.matchMedia = realMatchMedia
})

function renderPanel(onOpenDocument = vi.fn()) {
  const source = fakeFilesSource({ listDocuments: () => Promise.resolve(entries) })
  render(<WorkspaceFilesPanel source={source} onOpenDocument={onOpenDocument} />)
  return onOpenDocument
}

async function openCardMenu() {
  await waitFor(() => {
    expect(screen.getAllByTestId('card-title').length).toBeGreaterThan(0)
  })
  const card = screen.getAllByTestId('card-title')[0]?.closest('button') as HTMLElement
  fireEvent.contextMenu(card, { clientX: 40, clientY: 40 })
  return screen.findByRole('menu', { name: 'Document actions' })
}

describe('peek', () => {
  it('coarse: the menu offers Preview, and it shows the document without opening it', async () => {
    coarse = true
    const onOpenDocument = renderPanel()

    const menu = await openCardMenu()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Preview' }))

    const dialog = await screen.findByRole('dialog', { name: /Meeting notes/ })
    expect(within(dialog).getByTestId('okf-preview')).toBeTruthy()
    expect(onOpenDocument).not.toHaveBeenCalled()
  })

  it('coarse: Open from the peek opens the document and closes the peek', async () => {
    coarse = true
    const onOpenDocument = renderPanel()

    const menu = await openCardMenu()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Preview' }))
    const dialog = await screen.findByRole('dialog', { name: /Meeting notes/ })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Open' }))
    expect(onOpenDocument).toHaveBeenCalledWith('meeting-notes')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Meeting notes/ })).toBeNull())
  })

  it('coarse: Escape closes the peek without opening', async () => {
    coarse = true
    const onOpenDocument = renderPanel()

    const menu = await openCardMenu()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Preview' }))
    const dialog = await screen.findByRole('dialog', { name: /Meeting notes/ })

    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Meeting notes/ })).toBeNull())
    expect(onOpenDocument).not.toHaveBeenCalled()
  })

  it('fine pointer: no Preview verb — the pane beside the list already answers it', async () => {
    renderPanel()
    const menu = await openCardMenu()
    expect(within(menu).queryByRole('menuitem', { name: 'Preview' })).toBeNull()
  })
})
