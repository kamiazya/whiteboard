/**
 * The list in a tab that did NOT run the move. The demoting tab re-points its
 * own identity; every other tab keeps the moved workspace's id until it hears
 * the move, or meets the registry's refusal on its next read. Either way it
 * moves to a workspace this browser still keeps and says why, rather than
 * reporting a storage failure for a move that worked.
 *
 * "Another tab" is the removal written by hand — the registry row dropped and
 * the tombstone written, as the demote does — because the demote itself
 * re-points this realm's identity, which is the very state the other tab
 * never reaches.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '../index.css'
import { idbContentClock } from '../lib/browser-document-summary.js'
import { openWhiteboardDb, WORKSPACES_STORE } from '../lib/browser-idb.js'
import {
  getBrowserWorkspaceId,
  resetBrowserWorkspaceIdForTests,
  resolveBrowserWorkspaceId,
  switchBrowserWorkspace,
} from '../lib/browser-workspace-id.js'
import { createSeededDocument } from '../lib/create-seeded-document.js'
import { FoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { LoroStore } from '../lib/loro-store.js'
import { announceWorkspaceRemoved } from '../lib/workspace-broadcast.js'
import { TOMBSTONE_STORE, writeTombstone } from '../lib/workspace-tombstone.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserIndexPage } from './BrowserIndexPage.js'

claimIsolatedWhiteboardDb('browserindexpage-movedtodaemon')

const NEIGHBOUR = '01ARZ3NDEKTSV4RRFFQ69G5FD0'
const THIRD = '01ARZ3NDEKTSV4RRFFQ69G5FD1'

beforeEach(async () => {
  await clearWhiteboardDb()
  resetBrowserWorkspaceIdForTests()
})
afterEach(cleanup)

const titles = () => screen.queryAllByTestId('card-title').map((each) => each.textContent)

/** A moved workspace holding one note, beside a neighbour holding another. */
async function seedTwoWorkspaces(): Promise<string> {
  const index = new FoldingBrowserIndex()
  const movedId = await resolveBrowserWorkspaceId()
  await index.createWorkspace({ workspaceId: movedId })
  await createSeededDocument(index, new LoroStore(), idbContentClock(), undefined, 'markdown')
  await index.createWorkspace({ workspaceId: NEIGHBOUR })
  await index.createDocument({ workspaceId: NEIGHBOUR, path: 'kept', kind: 'markdown' })
  return movedId
}

/** What another tab's demote leaves in the registry: no row, and a tombstone. */
async function removeElsewhere(workspaceId: string): Promise<void> {
  const db = await openWhiteboardDb()
  try {
    const tx = db.transaction([WORKSPACES_STORE, TOMBSTONE_STORE], 'readwrite')
    tx.objectStore(WORKSPACES_STORE).delete(workspaceId)
    writeTombstone(tx, workspaceId)
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

function renderList() {
  render(
    <MemoryRouter initialEntries={['/']}>
      <BrowserIndexPage index={new FoldingBrowserIndex()} onOpenDocument={vi.fn()} />
    </MemoryRouter>,
  )
}

it('on hearing the move, lists a workspace still kept here and says why', async () => {
  const movedId = await seedTwoWorkspaces()
  renderList()
  await waitFor(() => expect(titles()).toEqual(['Untitled']), { timeout: 15_000 })

  await removeElsewhere(movedId)
  announceWorkspaceRemoved(movedId)

  await screen.findByTestId('workspace-moved-notice', {}, { timeout: 15_000 })
  await waitFor(() => expect(titles()).toEqual(['kept']), { timeout: 15_000 })
  expect(getBrowserWorkspaceId()).toBe(NEIGHBOUR)
  expect(screen.queryByRole('alert')).toBeNull()
  // Still there once the tab has landed: the notice explains the switch the
  // person is now looking at, so landing must not be what clears it.
  expect(screen.getByTestId('workspace-moved-notice')).toBeInTheDocument()
})

it('drops the notice once the person switches to another workspace', async () => {
  const movedId = await seedTwoWorkspaces()
  const index = new FoldingBrowserIndex()
  await index.createWorkspace({ workspaceId: THIRD })
  await index.createDocument({ workspaceId: THIRD, path: 'elsewhere', kind: 'markdown' })
  renderList()
  await waitFor(() => expect(titles()).toEqual(['Untitled']), { timeout: 15_000 })
  await removeElsewhere(movedId)
  announceWorkspaceRemoved(movedId)
  await screen.findByTestId('workspace-moved-notice', {}, { timeout: 15_000 })
  await waitFor(() => expect(titles()).toEqual(['kept']), { timeout: 15_000 })

  await switchBrowserWorkspace(THIRD)

  await waitFor(() => expect(titles()).toEqual(['elsewhere']), { timeout: 15_000 })
  expect(screen.queryByTestId('workspace-moved-notice')).toBeNull()
})

it('meeting the refusal on a load, moves off it instead of reporting a failure', async () => {
  const movedId = await seedTwoWorkspaces()
  await removeElsewhere(movedId)

  renderList()

  await screen.findByTestId('workspace-moved-notice', {}, { timeout: 15_000 })
  await waitFor(() => expect(titles()).toEqual(['kept']), { timeout: 15_000 })
  expect(getBrowserWorkspaceId()).toBe(NEIGHBOUR)
  expect(screen.queryByRole('alert')).toBeNull()
})

it('a create that meets the refusal moves off it instead of reporting a failure', async () => {
  const index = new FoldingBrowserIndex()
  const movedId = await resolveBrowserWorkspaceId()
  await index.createWorkspace({ workspaceId: movedId })
  await index.createWorkspace({ workspaceId: NEIGHBOUR })
  await index.createDocument({ workspaceId: NEIGHBOUR, path: 'kept', kind: 'markdown' })
  renderList()
  const create = await screen.findByRole(
    'button',
    { name: /create a canvas/i },
    { timeout: 15_000 },
  )

  await removeElsewhere(movedId)
  create.click()

  await screen.findByTestId('workspace-moved-notice', {}, { timeout: 15_000 })
  await waitFor(() => expect(titles()).toEqual(['kept']), { timeout: 15_000 })
  expect(screen.queryByRole('alert')).toBeNull()
})
