/**
 * A daemon-kept document whose stored content this build cannot read must
 * SAY so on the daemon page, the way the browser page already does.
 *
 * The sync session classifies the refused snapshot (`retired-stored-shape`,
 * `retired-comment-plane`) and binds no editor, which is right — but a page
 * that never reads that classification leaves the person on the loading copy
 * for good. What this file pins is the last leg: the shared read-failure
 * screen, with no editor behind it and nothing pushed.
 */

import {
  writeCoreFacets,
  writeDocumentKind,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import { getShellConnection, resetShellStatusForTests } from '../lib/shell-status-store.js'
import { FakeDocumentBackend, renderInRouter } from '../test-utils/daemon-page-harness.js'

vi.mock('../lib/daemon-api-client.js', async (importOriginal) =>
  (await import('../test-utils/daemon-page-harness.js')).daemonApiClientMock(importOriginal, [
    'listWorkspaces',
    'listDocuments',
    'createDocument',
  ]),
)

vi.mock('../lib/replica-refresh.js', async () =>
  (await import('../test-utils/daemon-page-harness.js')).replicaRefreshMock(),
)

// Markers rather than null: "the editor did not render" is the guarantee
// this file exists for, and a null mock makes it unassertable.
vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: () => <div data-testid="mock-spatial-editor" />,
}))
vi.mock('../components/markdown-editor/MarkdownEditor.js', () => ({
  MarkdownEditor: () => <div data-testid="mock-markdown-editor" />,
}))

const { DaemonDocumentPage } = await import('./DaemonDocumentPage.js')

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'

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

/** A board with one row still in the flat comments plane an older version kept. */
function boardStillHoldingFlatComments(): Uint8Array {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, { nodes: [], edges: [] })
  writeDocumentKind(doc, 'spatial')
  // The flat plane's key, spelled as the old writer did: the constant is the adapter's own.
  doc.getMap('comments').set('c1', { id: 'c1', text: 'old', x: 0, y: 0 })
  doc.commit()
  return doc.export({ mode: 'snapshot' })
}

/** A note this build reads, so the control proves the screen is a refusal and not the page's default. */
function readableNote(): Uint8Array {
  const doc = new LoroDoc()
  writeMarkdownBody(doc, '# Readable')
  writeCoreFacets(doc, { type: 'markdown' })
  writeDocumentKind(doc, 'markdown')
  return doc.export({ mode: 'snapshot' })
}

function mount(seed: () => Uint8Array, kind: 'markdown' | 'spatial'): FakeDocumentBackend {
  vi.mocked(daemonApiClient.listDocuments).mockResolvedValue({
    documents: [
      { path: 'doc', documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', updatedAt: '2026-01-01', kind },
    ],
  })
  const backend = new FakeDocumentBackend(seed)
  renderInRouter(
    <DaemonDocumentPage
      daemonBaseUrl={DAEMON_BASE_URL}
      workspaceId="w1"
      path="doc"
      createBackend={() => backend}
    />,
  )
  return backend
}

describe('a daemon-kept document this build cannot read', () => {
  beforeEach(() => {
    vi.mocked(daemonApiClient.listWorkspaces).mockResolvedValue({
      workspaces: [{ workspaceId: 'w1' }],
    })
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    resetShellStatusForTests()
  })

  it('a note still holding its body as the okf-body node shows the read-failure screen, not the loading copy', async () => {
    const backend = mount(noteStillHoldingOkfBody, 'markdown')
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/form this version no longer reads/i)
    })
    expect(screen.queryByTestId('document-opening-notice')).toBeNull()
    expect(screen.queryByTestId('mock-markdown-editor')).toBeNull()
    expect(backend.pushed).toEqual([])
    // The shell chip reads the same screen: no session was built, and
    // nothing retries it, so it must not claim to be reconnecting over an
    // error screen that offers no retry.
    expect(getShellConnection()?.state).toEqual({ keeper: 'daemon', session: 'not-opened' })
  })

  it('a board still holding the flat comments plane shows the read-failure screen, not the loading copy', async () => {
    const backend = mount(boardStillHoldingFlatComments, 'spatial')
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/comments saved by an older version/i)
    })
    expect(screen.queryByTestId('document-opening-notice')).toBeNull()
    expect(screen.queryByTestId('mock-spatial-editor')).toBeNull()
    expect(backend.pushed).toEqual([])
  })

  it('control: a readable note opens its editor and raises no alert', async () => {
    mount(readableNote, 'markdown')
    await waitFor(() => expect(screen.getByTestId('mock-markdown-editor')).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
