/**
 * The comments panel, mounted (ADR-0026 decision 5). What this asserts that
 * the panel's own component test cannot is the WIRING: a thread stored in
 * the document's threads plane reaches the panel, through the session's
 * annotation channel and the page.
 *
 * SpatialEditor is mocked — the subject is the document-level surface, not
 * the canvas — which is also the point. The panel is not canvas chrome: it
 * has to serve a markdown document, and a markdown document has no canvas to
 * hang anything on.
 */
import type { DocumentBackendHandlers } from '@kamiazya/whiteboard-mcp/browser-contract'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import { LocalStoreDouble } from '../test-utils/local-index.js'
import '../index.css'

vi.mock('../components/spatial-editor/index.js', () => ({
  // Fills its host the way the real editor does. A zero-height stand-in makes
  // any geometric assertion about the surface vacuous — the overlap case below
  // passed against the very layout it exists to reject.
  SpatialEditor: (_props: { canvas: SpatialCanvas }) => (
    <div data-testid="mock-spatial-editor" style={{ height: '100%', width: '100%' }} />
  ),
}))

vi.mock('../lib/browser-backend.js', async () => {
  const { FakeBrowserBackend, workspaceSnapshotFor } = await import(
    '../test-utils/fake-browser-backend.js'
  )
  const { documentContainers: containersOf, writeCommentThread: writeThread } = await import(
    '@kamiazya/whiteboard-loro-adapter'
  )
  const { LoroDoc: Doc } = await import('loro-crdt')
  class ThreadSeedingBackend extends FakeBrowserBackend {
    // Named from the published contract rather than derived off the base
    // class: inside a `vi.mock` factory the base is a dynamic import, so a
    // `Parameters<…>` lookup over it resolves to `unknown`.
    connect(handlers: DocumentBackendHandlers): void {
      // Rebuilt from the shared helper's snapshot so the workspace-document
      // shape stays the real one; only the threads plane is added on top.
      const doc = new Doc()
      doc.import(workspaceSnapshotFor(this.target, { nodes: [], edges: [] }))
      const content = containersOf(doc, this.target.documentId)
      writeThread(content, {
        id: 't-open',
        anchor: { kind: 'spatial', x: 20, y: 30 },
        status: 'open',
        messages: [{ id: 'm1', body: 'still needs a decision' }],
      })
      writeThread(content, {
        id: 't-done',
        anchor: { kind: 'spatial', x: 40, y: 50 },
        status: 'resolved',
        messages: [{ id: 'm2', body: 'settled last week' }],
      })
      handlers.onConnected()
      handlers.onSnapshot(doc.export({ mode: 'snapshot' }))
    }
  }
  return { BrowserBackend: ThreadSeedingBackend }
})

const { BrowserDocumentPage } = await import('./BrowserDocumentPage.js')

function render(ui: ReactElement) {
  return rtlRender(
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </div>,
  )
}

const snap: DocumentSnapshot = {
  documentId: '0W16BGNTZ49EKRX27CHPV05AFM',
  workspaceId: 'local',
  path: 'notes/reviewed',
  name: 'Reviewed',
  updatedAt: '2026-09-03T00:00:00.000Z',
  kind: 'spatial' as const,
}

afterEach(() => {
  cleanup()
})

it('opens a rail listing this document conversations, open ones first and by default', async () => {
  const store = new LocalStoreDouble()
  await store.setDefaultDocumentId(snap.documentId)
  await store.save(snap)

  render(<BrowserDocumentPage store={store.index} pointer={store.pointer} clock={store.clock} />)
  await screen.findByTestId('mock-spatial-editor', undefined, { timeout: 15_000 })

  // Closed by default: the panel answers a question the reader asks, rather
  // than taking a rail's width from everyone who never asks it.
  expect(screen.queryByTestId('comments-panel')).toBeNull()

  await userEvent.click(await screen.findByRole('button', { name: /comments/i }))

  await waitFor(() => expect(screen.getByText('still needs a decision')).toBeInTheDocument(), {
    timeout: 15_000,
  })
  // Resolved is one filter away, not on screen by default.
  expect(screen.queryByText('settled last week')).toBeNull()
})

it('counts the OPEN conversations on the opener, so the rail need not be open to know', async () => {
  const store = new LocalStoreDouble()
  await store.setDefaultDocumentId(snap.documentId)
  await store.save(snap)

  render(<BrowserDocumentPage store={store.index} pointer={store.pointer} clock={store.clock} />)
  await screen.findByTestId('mock-spatial-editor', undefined, { timeout: 15_000 })

  // One of the two threads is resolved; a badge counting both would report
  // work that is done as work outstanding.
  await waitFor(() => expect(screen.getByRole('button', { name: /comments, 1 open/i })), {
    timeout: 15_000,
  })
})

it('keeps the opener out of the editor surface, so it cannot swallow the editor own controls', async () => {
  const store = new LocalStoreDouble()
  await store.setDefaultDocumentId(snap.documentId)
  await store.save(snap)

  render(<BrowserDocumentPage store={store.index} pointer={store.pointer} clock={store.clock} />)
  const surface = await screen.findByTestId('mock-spatial-editor', undefined, { timeout: 15_000 })
  const opener = await screen.findByRole('button', { name: /comments/i })

  // A geometric assertion rather than a class one: floated over the surface's
  // top-right corner, this control sat on top of whatever chrome the mounted
  // editor puts there — measured, the markdown editor's own catalog trigger,
  // which then could not be clicked at all. Where the opener lives is a
  // decision; that it overlaps nothing is the invariant.
  const a = opener.getBoundingClientRect()
  const b = surface.getBoundingClientRect()
  const overlaps = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  expect({ overlaps, opener: a.toJSON(), surface: b.toJSON() }).toMatchObject({ overlaps: false })
})

it('offers the same opener on a markdown document, which has no canvas chrome to carry one', async () => {
  const store = new LocalStoreDouble()
  const note = { ...snap, kind: 'markdown' as const, documentId: '0W16BGNTZ49EKRX27CHPV05AFN' }
  await store.setDefaultDocumentId(note.documentId)
  await store.save(note)

  render(<BrowserDocumentPage store={store.index} pointer={store.pointer} clock={store.clock} />)

  // The claim ADR-0026 decision 5 rests on: a document with no canvas still
  // reaches its conversations. Nothing else in this file would notice if the
  // opener rode canvas-only chrome.
  await waitFor(
    () => expect(screen.getByRole('button', { name: /comments/i })).toBeInTheDocument(),
    {
      timeout: 15_000,
    },
  )
  expect(screen.queryByTestId('mock-spatial-editor')).toBeNull()
})
