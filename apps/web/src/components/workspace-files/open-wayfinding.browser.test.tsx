// The open wayfinding contract, in a REAL browser — jsdom's synthetic
// events cannot prove the parts that live in native event ORDER: a real
// double-click dispatches click, click, dblclick (so the open must arrive
// exactly once, after two harmless selects), and a real Enter on a focused
// <button> fires the native click that our keydown preventDefault has to
// swallow (without it, Enter would open AND select).
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

afterEach(cleanup)

const entries = [
  { documentId: 'd1', path: 'meeting-notes', name: 'Meeting notes', kind: 'markdown' as const },
]

const realMatchMedia = window.matchMedia
let coarse = false
beforeEach(() => {
  coarse = false
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
  window.matchMedia = realMatchMedia
})

function renderPanel(onOpenDocument: (path: string) => void) {
  const source = fakeFilesSource({ listDocuments: async () => entries })
  render(<WorkspaceFilesPanel source={source} onOpenDocument={onOpenDocument} />)
}

async function card() {
  const title = (await screen.findAllByTestId('card-title'))[0] as HTMLElement
  return title.closest('button') as HTMLElement
}

describe('open wayfinding', () => {
  it('double-click opens once', async () => {
    const onOpenDocument = vi.fn()
    renderPanel(onOpenDocument)
    await userEvent.dblClick(await card())
    expect(onOpenDocument).toHaveBeenCalledTimes(1)
    expect(onOpenDocument).toHaveBeenCalledWith('meeting-notes')
  })

  it('Enter opens once, without a stray select', async () => {
    const onOpenDocument = vi.fn()
    renderPanel(onOpenDocument)
    const button = await card()
    button.focus()
    await userEvent.keyboard('{Enter}')
    expect(onOpenDocument).toHaveBeenCalledTimes(1)
    // The native Enter->click was swallowed: nothing selected, so the
    // preview pane still shows its empty state.
    expect(screen.getByText('Select a document to preview its content.')).toBeTruthy()
  })

  it('coarse: tap opens, no preview pane', async () => {
    coarse = true
    const onOpenDocument = vi.fn()
    renderPanel(onOpenDocument)
    const button = await card()
    expect(screen.queryByText('Select a document to preview its content.')).toBeNull()
    await userEvent.click(button)
    expect(onOpenDocument).toHaveBeenCalledWith('meeting-notes')
  })

  it('coarse: touch long-press opens the sheet, not the document', async () => {
    coarse = true
    const onOpenDocument = vi.fn()
    renderPanel(onOpenDocument)
    const button = await card()

    // A real held touch: pointerdown with pointerType touch, no release
    // until the menu shows. userEvent has no long-press, so dispatch the
    // native events the browser would.
    const rect = button.getBoundingClientRect()
    button.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerType: 'touch',
        pointerId: 7,
        clientX: rect.x + 10,
        clientY: rect.y + 10,
        bubbles: true,
      }),
    )
    const menu = await screen.findByRole('menu', { name: 'Document actions' })
    expect(within(menu).getByRole('menuitem', { name: 'Rename…' })).toBeTruthy()

    button.dispatchEvent(
      new PointerEvent('pointerup', { pointerType: 'touch', pointerId: 7, bubbles: true }),
    )
    button.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true, cancelable: true }))
    expect(onOpenDocument).not.toHaveBeenCalled()
    // The sheet closes on Escape and the release did not leak an open.
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Document actions' })).toBeNull())
  })
})
