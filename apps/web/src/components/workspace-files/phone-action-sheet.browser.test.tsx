/**
 * The home list's action sheet on a phone: docked to the screen's bottom
 * edge, dimming the whole screen, and tall enough for every action it holds
 * — the panel it is opened from is inset from the screen and shorter than it.
 */

import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import '../../index.css'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { setViewport } from '../../test-utils/viewport.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

const realMatchMedia = window.matchMedia
beforeEach(async () => {
  await setViewport(412, 839)
  window.matchMedia = (query: string) =>
    query === '(pointer: coarse)'
      ? ({
          matches: true,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        } as unknown as MediaQueryList)
      : realMatchMedia.call(window, query)
})
afterEach(async () => {
  cleanup()
  window.matchMedia = realMatchMedia
  await setViewport(1280, 800)
})

function renderInsetPanel() {
  const rows: WorkspaceDocumentEntry[] = [
    { documentId: 'd1', path: 'biology', name: 'Cell biology', kind: 'spatial' },
  ]
  const source = fakeFilesSource({
    listDocuments: async () => rows,
    listFolderNames: async () => [],
    setFolderName: async () => {},
    setPinned: async () => {},
  })
  render(
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        padding: '56px 16px 16px',
      }}
    >
      <WorkspaceFilesPanel
        source={source}
        onOpenDocument={vi.fn()}
        onDuplicateDocument={vi.fn()}
        onRequestDelete={vi.fn()}
      />
    </div>,
    { container: document.body },
  )
}

describe('the card action sheet on a phone', () => {
  it('docks to the screen edge, dims it all, and shows every action', async () => {
    renderInsetPanel()
    await userEvent.click(await screen.findByRole('button', { name: 'Cell biology actions' }))
    const menu = await screen.findByRole('menu', { name: 'Document actions' })

    await expect
      .poll(() => Math.round(menu.getBoundingClientRect().bottom))
      .toBe(window.innerHeight)
    // Taller than half the screen, or the sheet's own half-height cap would fit it anyway.
    expect(menu.scrollHeight).toBeGreaterThan(window.innerHeight / 2)
    expect(menu.scrollHeight).toBeLessThanOrEqual(menu.clientHeight)
    const remove = within(menu).getByRole('menuitem', { name: 'Delete' })
    expect(remove.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight)

    const scrim = screen.getByTestId('context-menu-scrim').getBoundingClientRect()
    expect(scrim.top).toBeLessThanOrEqual(0)
    expect(scrim.bottom).toBeGreaterThanOrEqual(window.innerHeight)
    expect(scrim.left).toBeLessThanOrEqual(0)
    expect(scrim.right).toBeGreaterThanOrEqual(window.innerWidth)
  })
})
