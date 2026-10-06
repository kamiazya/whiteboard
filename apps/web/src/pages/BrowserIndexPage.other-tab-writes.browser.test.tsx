/**
 * The browser list follows what ANOTHER tab writes, on the same mount.
 *
 * Every tab of this origin keeps its own index over one IndexedDB record, and
 * nothing re-reads a list another tab changed except a broadcast — the daemon
 * list answers the same need through its update frames. "Another tab" here is
 * a second `FoldingBrowserIndex`: what separates two tabs is two index
 * instances writing one record, each announcing on the workspace channel, and
 * a channel end never hears its own posts, so an announcement this page heard
 * is one a different end sent.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '../index.css'
import { idbContentClock } from '../lib/browser-document-summary.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { createSeededDocument } from '../lib/create-seeded-document.js'
import { FoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { LoroStore } from '../lib/loro-store.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserIndexPage } from './BrowserIndexPage.js'

claimIsolatedWhiteboardDb('browserindexpage-othertabwrites')

beforeEach(async () => {
  await clearWhiteboardDb()
})
afterEach(cleanup)

const titles = () => screen.queryAllByTestId('card-title').map((each) => each.textContent)

const seed = (index: FoldingBrowserIndex) =>
  createSeededDocument(index, new LoroStore(), idbContentClock(), undefined, 'markdown')

/** Tab A on the list, after tab B has written one document it can see. */
async function openTabs() {
  const tabB = new FoldingBrowserIndex()
  const first = await seed(tabB)
  render(
    <MemoryRouter initialEntries={['/']}>
      <BrowserIndexPage index={new FoldingBrowserIndex()} onOpenDocument={vi.fn()} />
    </MemoryRouter>,
  )
  await waitFor(() => expect(titles()).toEqual(['untitled']), { timeout: 15_000 })
  return { tabB, first }
}

it('shows a document another tab creates', async () => {
  const { tabB } = await openTabs()
  await seed(tabB)
  await waitFor(() => expect(titles()).toEqual(['untitled', 'untitled-2']), { timeout: 15_000 })
})

it('shows a copy another tab duplicates', async () => {
  const { tabB } = await openTabs()
  await tabB.duplicateDocument({ workspaceId: getBrowserWorkspaceId(), path: 'untitled' })
  await waitFor(() => expect(titles()).toHaveLength(2), { timeout: 15_000 })
})

it('shows a name another tab chooses', async () => {
  const { tabB, first } = await openTabs()
  const workspaceId = getBrowserWorkspaceId()
  await tabB.setDocumentName({ workspaceId, documentId: first.documentId, name: 'Named in B' })
  await waitFor(() => expect(titles()).toEqual(['Named in B']), { timeout: 15_000 })
})

it('shows a pin another tab sets', async () => {
  const { tabB, first } = await openTabs()
  const workspaceId = getBrowserWorkspaceId()
  await tabB.setDocumentPinned({ workspaceId, documentId: first.documentId, pinned: true })
  await waitFor(
    () => {
      const card = screen.getByTestId('card-title').closest('button')
      expect(card).not.toBeNull()
      expect(within(card as HTMLElement).getByLabelText('Pinned')).toBeTruthy()
    },
    { timeout: 15_000 },
  )
})
