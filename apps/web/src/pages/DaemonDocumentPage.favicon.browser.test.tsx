// The tab icon over the daemon page: fed from the same session judgement the
// shell draws, so a credential the stream refuses draws the offline icon. The
// `dot` style keeps the expected icon independent of the document's outline.

import { writeDocumentKind, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { act, cleanup, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../index.css'
import { renderFavicon } from '../lib/favicon.js'
import { getShellConnection, resetShellStatusForTests } from '../lib/shell-status-store.js'
import { createUserSettingsStore } from '../lib/user-settings-store.js'
import { FakeDocumentBackend, renderPage } from '../test-utils/daemon-page-harness.js'
import { jsonResponse } from '../test-utils/json-response.js'

vi.mock('../lib/daemon-api-client.js', async (importOriginal) => {
  const { daemonApiClientMock, daemonWithOneDocument } = await import(
    '../test-utils/daemon-page-harness.js'
  )
  return daemonApiClientMock(
    importOriginal,
    ['listWorkspaces', 'listDocuments', 'createDocument', 'getDocumentBacklinks'],
    daemonWithOneDocument({ path: 'board', documentId: 'id-board', kind: 'spatial' }),
  )
})

vi.mock('../lib/replica-refresh.js', async () =>
  (await import('../test-utils/daemon-page-harness.js')).replicaRefreshMock(),
)

const { DaemonDocumentPage } = await import('./DaemonDocumentPage.js')

function seededSnapshot(): Uint8Array {
  const doc = new LoroDoc()
  writeDocumentKind(doc, 'spatial')
  writeSpatialCanvas(doc, {
    nodes: [textNode({ id: 'n1', x: 100, y: 100, width: 200, height: 100, text: 'hello' })],
    edges: [],
  })
  return doc.export({ mode: 'snapshot' })
}

const iconHref = () =>
  document.head.querySelector('link[rel="icon"][data-wb-favicon]')?.getAttribute('href') ?? null

describe('the daemon page tab icon', () => {
  beforeEach(() => {
    resetShellStatusForTests()
    createUserSettingsStore().update((s) => ({
      ...s,
      appearance: { ...s.appearance, faviconStyle: 'dot' },
    }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, 404)),
    )
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    resetShellStatusForTests()
    window.localStorage.clear()
  })

  it('draws the offline icon once the stream refuses the credential', async () => {
    const created: FakeDocumentBackend[] = []
    renderPage(
      <DaemonDocumentPage
        daemonBaseUrl="http://127.0.0.1:3099"
        workspaceId="w1"
        path="board"
        createBackend={() => {
          const backend = new FakeDocumentBackend(seededSnapshot)
          created.push(backend)
          return backend
        }}
      />,
    )
    await screen.findByTestId('spatial-editor', undefined, { timeout: 15_000 })
    const quiet = renderFavicon({ style: 'dot', status: 'quiet', rects: [] })
    const offline = renderFavicon({ style: 'dot', status: 'offline', rects: [] })
    expect(quiet).not.toBe(offline)
    await waitFor(() => expect(iconHref()).toBe(quiet), { timeout: 5000 })

    await act(async () => {
      created[0]?.handlers?.onAuthError?.('stream')
    })
    await waitFor(() =>
      expect(getShellConnection()?.state).toEqual({ keeper: 'daemon', session: 'sync-off' }),
    )
    await waitFor(() => expect(iconHref()).toBe(offline), { timeout: 3000 })
  })
})
