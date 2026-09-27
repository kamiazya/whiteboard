/**
 * A markdown document saying which of its conversations have lost their
 * passage (ADR-0026 decision 4).
 *
 * Until the anchor reader existed, the page passed `resolveAnchor` as
 * `undefined` for a note — which the panel correctly reads as "this host
 * cannot tell", and which was true. The consequence was not a wrong badge but
 * an ABSENT one: a thread whose sentence had been deleted looked exactly like
 * one whose sentence was still there, in a surface whose whole job is to tell
 * you what is still open.
 *
 * Two threads on one document, so the assertion is a DIFFERENCE rather than a
 * presence: with a resolver that answered the same thing for everything, both
 * would be marked or neither would, and either way this file would pass on a
 * claim it had not made.
 */
import type { DocumentBackendHandlers } from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import {
  type DocumentContainers,
  writeCommentThread,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import { LocalStoreDouble } from '../test-utils/local-index.js'

// jsdom has no IndexedDB, so the startup fold cannot run here: it throws, the
// production path catches it and continues, and that guarded continue is
// exactly what these tests already run under. Mocked to the same outcome
// rather than left to throw, because the warn it logs on the way is noise in a
// channel that has to stay readable — `vitest.setup.ts`'s act guard and
// `web-browser`'s wider one both live there. Measured: 36 of the project's 78
// console records were this one line.
vi.mock('../lib/fold-workspace.js', () => ({
  foldWorkspaceDocuments: async () => ({ folded: 0, skipped: 0 }),
}))

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: () => <div data-testid="mock-spatial-editor" />,
}))

// A note is served by its BrowserBackend session like a board, and jsdom has
// no IndexedDB for the real one: this double delivers the workspace shape the
// real backend does, with the note's body and threads on its node.
vi.mock('../lib/browser-backend.js', async () => {
  const { FakeBrowserBackend, workspaceSnapshotFor } = await import(
    '../test-utils/fake-browser-backend.js'
  )
  const { documentContainers: containersOf } = await import('@kamiazya/whiteboard-loro-adapter')
  const { LoroDoc: Doc } = await import('loro-crdt')
  class NoteSeedingBackend extends FakeBrowserBackend {
    connect(handlers: DocumentBackendHandlers): void {
      const doc = new Doc()
      doc.import(workspaceSnapshotFor(this.target))
      seed.note(containersOf(doc, this.target.documentId))
      doc.commit()
      handlers.onConnected()
      handlers.onSnapshot(doc.export({ mode: 'snapshot' }))
    }
  }
  return { BrowserBackend: NoteSeedingBackend }
})

const seed = vi.hoisted(() => ({ note: (_containers: DocumentContainers): void => {} }))

const { BrowserDocumentPage } = await import('./BrowserDocumentPage.js')

function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>)
}

const note: DocumentSnapshot = {
  documentId: '0W16BGNTZ49EKRX27CHPV05AFN',
  workspaceId: 'local',
  path: 'notes/plan',
  name: 'Plan',
  updatedAt: '2026-09-04T00:00:00.000Z',
  kind: 'markdown' as const,
}

const BODY = 'Ship the annotation layer in three steps.'

/** One thread whose quote is in the body, and one whose quote is not. */
function noteWithBothKinds(doc: DocumentContainers): void {
  writeMarkdownBody(doc, BODY)
  const at = BODY.indexOf('three steps')
  writeCommentThread(doc, {
    id: 't-here',
    anchor: {
      kind: 'text',
      quote: { exact: 'three steps' },
      start: at,
      end: at + 'three steps'.length,
    },
    status: 'open',
    messages: [{ id: 'm1', body: 'is three still right?' }],
  })
  writeCommentThread(doc, {
    id: 't-gone',
    // A passage that was in the body when the thread was written and is not
    // any more — the ordinary result of someone editing the paragraph.
    anchor: { kind: 'text', quote: { exact: 'by Friday' }, start: 0, end: 9 },
    status: 'open',
    messages: [{ id: 'm2', body: 'still by Friday?' }],
  })
}
seed.note = noteWithBothKinds

afterEach(cleanup)

it('marks the conversation whose passage is gone, and only that one', async () => {
  const store = new LocalStoreDouble()
  await store.setDefaultDocumentId(note.documentId)
  await store.save(note)

  render(
    <BrowserDocumentPage
      store={store.index}
      pointer={store.pointer}
      clock={store.clock}
      loro={store.loro}
    />,
  )

  await waitFor(() => expect(screen.getByRole('button', { name: /comments/i })).toBeTruthy())
  screen.getByRole('button', { name: /comments/i }).click()

  await waitFor(() => expect(screen.getByTestId('thread-orphaned-t-gone')).toBeTruthy())
  // The difference is the claim: a resolver that marked everything would pass
  // the line above and fail this one.
  expect(screen.queryByTestId('thread-orphaned-t-here')).toBeNull()
})
