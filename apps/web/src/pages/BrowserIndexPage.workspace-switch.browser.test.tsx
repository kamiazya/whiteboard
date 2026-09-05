/**
 * The card list follows a workspace switch — in a real browser, over real
 * IndexedDB and the real switch path.
 *
 * jsdom can drive the identity accessor directly; only this layer runs the
 * actual `switchBrowserWorkspace` against a real registry with two real
 * workspaces. Both hold a document called `untitled` — the collision this
 * bug rides on — so the workspaces are told apart by COUNT, which is what a
 * hand-run of this same flow needed too (measured: with one document each,
 * the stale list and the correct one are the same two words).
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '../index.css'
import { getBrowserWorkspaceId, switchBrowserWorkspace } from '../lib/browser-workspace-id.js'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { LocalStoreDouble } from '../test-utils/local-index.js'
import { BrowserIndexPage } from './BrowserIndexPage.js'

claimIsolatedWhiteboardDb('browserindexpage-workspace-switch')

const OTHER = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

beforeEach(async () => {
  await clearWhiteboardDb()
})
afterEach(cleanup)

const titles = () => screen.getAllByTestId('card-title').map((el) => el.textContent)

it('lists the workspace switched to, told apart by count', async () => {
  const settled = getBrowserWorkspaceId()
  const store = new LocalStoreDouble()
  await store.save({
    documentId: '0CFJNRVY147ADGKPSWZ258BEHM',
    workspaceId: settled,
    path: 'untitled',
    name: 'untitled',
    updatedAt: '2026-09-01T00:00:00Z',
    kind: 'spatial',
  })
  await store.index.createWorkspace({ workspaceId: OTHER, segment: 'second' })
  // The REAL registry too: `switchBrowserWorkspace` resolves a handle against
  // IndexedDB, not against the injected index — without these it answers null
  // and no switch happens, which reads exactly like a list that did not
  // follow (measured: the first version of this test failed that way).
  await new IdbDocumentIndex().createWorkspace({ workspaceId: settled, segment: 'default' })
  await new IdbDocumentIndex().createWorkspace({ workspaceId: OTHER, segment: 'second' })
  for (const [documentId, path] of [
    ['0Z258BEHMQTX0369CFJNRVY147', 'untitled'],
    ['069CFJNRVY147ADGKPSWZ258BE', 'untitled-2'],
  ] as const) {
    store.index.seed({ workspaceId: OTHER, documentId, path, kind: 'markdown' })
  }

  render(
    <MemoryRouter initialEntries={['/']}>
      <BrowserIndexPage
        index={store.index}
        loro={store.loro}
        pointer={store.pointer}
        clock={store.clock}
        onOpenDocument={vi.fn()}
      />
    </MemoryRouter>,
    { container: document.body },
  )

  await waitFor(() => expect(titles()).toHaveLength(1))
  // Asserted, not assumed: a switch that did not happen leaves the list
  // unchanged, which is indistinguishable from the bug under test.
  expect(await switchBrowserWorkspace('second')).not.toBeNull()
  await waitFor(() => expect(titles()).toHaveLength(2))
  expect(await switchBrowserWorkspace('default')).not.toBeNull()
  await waitFor(() => expect(titles()).toHaveLength(1))
})
