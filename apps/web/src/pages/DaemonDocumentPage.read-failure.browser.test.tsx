/**
 * The daemon page's read-failure screen in a REAL browser: the page
 * composition over the sync session, with the real editors available to
 * mount (none may), and the screen as a person sees it. The jsdom file
 * beside this one pins each reason; this is the one the eye checks.
 *
 * A corrupt snapshot is not covered on this page: with an injected backend the
 * session has no content id, and that is the one path on which
 * `unreadableSnapshot` answers `corrupt-snapshot`.
 */

import {
  writeCoreFacets,
  writeDocumentKind,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, expect, it, vi } from 'vitest'
import '../index.css'
import { FakeDocumentBackend, renderPage } from '../test-utils/daemon-page-harness.js'

vi.mock('../lib/daemon-api-client.js', async (importOriginal) => {
  const { daemonApiClientMock, daemonWithOneDocument } = await import(
    '../test-utils/daemon-page-harness.js'
  )
  return daemonApiClientMock(
    importOriginal,
    ['listWorkspaces', 'listDocuments', 'createDocument', 'getDocumentBacklinks'],
    daemonWithOneDocument({ path: 'old-note', documentId: 'id-note', kind: 'markdown' }),
  )
})

vi.mock('../lib/replica-refresh.js', async () =>
  (await import('../test-utils/daemon-page-harness.js')).replicaRefreshMock(),
)

const { DaemonDocumentPage } = await import('./DaemonDocumentPage.js')

/** A note as the pre-unification writer stored it: the body in a canvas text node, no `body`. */
function noteStillHoldingOkfBody(): Uint8Array {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: [textNode({ id: 'okf-body', x: 0, y: 0, width: 400, height: 200, text: '# Old note' })],
    edges: [],
  })
  writeCoreFacets(doc, { type: 'markdown' })
  writeDocumentKind(doc, 'markdown')
  return doc.export({ mode: 'snapshot' })
}

afterEach(cleanup)

it('a daemon note in a retired shape shows the read-failure screen in place of the loading copy', async () => {
  const backend = new FakeDocumentBackend(noteStillHoldingOkfBody)
  renderPage(
    <DaemonDocumentPage
      daemonBaseUrl="http://127.0.0.1:3099"
      workspaceId="w1"
      path="old-note"
      createBackend={() => backend}
    />,
  )
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeNull())
  expect(screen.getByRole('alert').textContent).toMatch(/form this version no longer reads/i)
  expect(screen.queryByTestId('document-opening-notice')).toBeNull()
  expect(screen.queryByTestId('markdown-source-wrap')).toBeNull()
  expect(backend.pushed).toEqual([])
})
