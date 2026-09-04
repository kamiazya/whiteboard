/**
 * The recovery a failed open offers, which is the half of this that can
 * destroy something.
 *
 * `Start fresh` DELETES the record. It is the right last resort for a
 * document this build genuinely cannot read — there is nothing to lose that
 * is not already lost — and it is the worst button in the app to put in front
 * of someone whose read was merely blocked, because their work is intact and
 * one click removes it. Until `read-unavailable` existed, every failure to
 * open the workspace record took that branch, so a second tab at an older
 * version was enough to be offered the delete.
 */
import type { DocumentBackendHandlers } from '@kamiazya/whiteboard-mcp/browser-contract'
import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import { LocalStoreDouble } from '../test-utils/local-index.js'

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: () => <div data-testid="mock-spatial-editor" />,
}))

// A backend whose load never completes, reporting the reason this file is
// about. Nothing is said about the stored bytes.
vi.mock('../lib/browser-backend.js', async () => {
  const { FakeBrowserBackend } = await import('../test-utils/fake-browser-backend.js')
  class UnavailableBackend extends FakeBrowserBackend {
    // Named from the published contract rather than derived off the base
    // class: inside a `vi.mock` factory the base is a dynamic import, so a
    // `Parameters<…>` lookup over it resolves to `unknown`.
    connect(handlers: DocumentBackendHandlers): void {
      handlers.onConnected()
      handlers.onError?.('read-unavailable')
    }
  }
  return { BrowserBackend: UnavailableBackend }
})

const { BrowserDocumentPage } = await import('./BrowserDocumentPage.js')

function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>)
}

const snap: DocumentSnapshot = {
  documentId: '0W16BGNTZ49EKRX27CHPV05AFM',
  workspaceId: 'local',
  path: 'notes/reviewed',
  name: 'Reviewed',
  updatedAt: '2026-09-04T00:00:00.000Z',
  kind: 'spatial' as const,
}

afterEach(cleanup)

it('offers a retry and never the delete when the read simply did not complete', async () => {
  const store = new LocalStoreDouble()
  await store.setDefaultDocumentId(snap.documentId)
  await store.save(snap)

  render(
    <BrowserDocumentPage
      store={store.index}
      pointer={store.pointer}
      clock={store.clock}
      loro={store.loro}
    />,
  )

  await waitFor(() => expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy())
  // The load-bearing half. A retry beside a delete would still be a delete
  // one slip away.
  expect(screen.queryByRole('button', { name: /start fresh/i })).toBeNull()
  // And it says what happened without claiming the data is damaged.
  expect(screen.getByRole('alert').textContent).toMatch(/has not been changed/i)
})
