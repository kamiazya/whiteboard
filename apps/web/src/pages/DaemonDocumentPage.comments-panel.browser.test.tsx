/**
 * The comments panel on the daemon page (ADR-0026 decision 5), real-browser
 * geometry only — the interaction surface (rail contents, reply routing,
 * orphaned marking, preview gating) is already pinned at the jsdom layer in
 * DaemonDocumentPage.comments-panel.test.tsx. What THIS file adds is the one
 * thing jsdom cannot check: the opener's real position relative to the
 * editor surface, mirroring the case that caught BrowserDocumentPage's own
 * overlay defect (see BrowserDocumentPage.comments-panel.browser.test.tsx).
 *
 * SpatialEditor is mocked — the subject is the document-level surface, not
 * the canvas.
 */

import { writeCommentThread } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import '../index.css'
import { FakeDocumentBackend, renderPage } from '../test-utils/daemon-page-harness.js'

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: (_props: { canvas: SpatialCanvas }) => (
    <div data-testid="mock-spatial-editor" style={{ height: '100%', width: '100%' }} />
  ),
}))

vi.mock('../lib/daemon-api-client.js', async (importOriginal) => {
  const { daemonApiClientMock, daemonWithOneDocument } = await import(
    '../test-utils/daemon-page-harness.js'
  )
  return daemonApiClientMock(
    importOriginal,
    ['listWorkspaces', 'listDocuments', 'createDocument', 'getDocumentBacklinks'],
    daemonWithOneDocument({ path: 'board', id: 'id-board', kind: 'spatial' }),
  )
})

vi.mock('../lib/replica-refresh.js', async () =>
  (await import('../test-utils/daemon-page-harness.js')).replicaRefreshMock(),
)

const { DaemonDocumentPage } = await import('./DaemonDocumentPage.js')

/**
 * One open thread, seeded at document root — matches how an injected
 * `createBackend` scopes a connection (see the note on `contentDocumentId` in
 * DaemonDocumentPage.comments-panel.test.tsx).
 */
function seededSnapshot(): Uint8Array {
  const doc = new LoroDoc()
  writeCommentThread(doc, {
    id: 't-open',
    anchor: { kind: 'spatial', x: 20, y: 30 },
    status: 'open',
    messages: [{ id: 'm1', body: 'still needs a decision' }],
  })
  return doc.export({ mode: 'snapshot' })
}

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('opens the rail from the document actions row, without the opener overlaying the editor surface', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 404 })),
  )

  renderPage(
    <DaemonDocumentPage
      daemonBaseUrl={DAEMON_BASE_URL}
      workspaceId="w1"
      path="board"
      createBackend={() => new FakeDocumentBackend(seededSnapshot)}
    />,
  )

  const surface = await screen.findByTestId('mock-spatial-editor', undefined, { timeout: 15_000 })
  const opener = await screen.findByRole('button', { name: /comments/i })

  // Geometric, not merely a class name: floated over the surface's top-right
  // corner, this control sat on top of whatever chrome the mounted editor
  // puts there — measured on the browser page, the markdown editor's own
  // catalog trigger, which then could not be clicked at all.
  const a = opener.getBoundingClientRect()
  const b = surface.getBoundingClientRect()
  const overlaps = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  expect({ overlaps, opener: a.toJSON(), surface: b.toJSON() }).toMatchObject({ overlaps: false })

  await userEvent.click(opener)
  await waitFor(() => expect(screen.getByText('still needs a decision')).toBeInTheDocument(), {
    timeout: 15_000,
  })
})
