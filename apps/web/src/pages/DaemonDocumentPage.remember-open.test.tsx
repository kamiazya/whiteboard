/**
 * A document opened by address — no card click — still enters the Recent lane
 * and gets its seen baseline from the listing, so it carries no "changed" dot
 * on the way back.
 */
import { act, cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { daemonMemoryScope } from '../components/workspace-files/use-device-memory.js'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import { readRecentIds } from '../lib/recent-documents.js'
import { readSeenDigest } from '../lib/seen-documents.js'
import { resetCapturedEditorProps } from '../test-utils/capturing-spatial-editor.js'
import { FakeDocumentBackend, MemoryRouterWrapper } from '../test-utils/daemon-page-harness.js'
import { DaemonDocumentPage } from './DaemonDocumentPage.js'

vi.mock('../lib/replica-refresh.js', async () =>
  (await import('../test-utils/daemon-page-harness.js')).replicaRefreshMock(),
)
vi.mock('../lib/daemon-api-client.js', async (importOriginal) =>
  (await import('../test-utils/daemon-page-harness.js')).daemonApiClientMock(importOriginal, [
    'listWorkspaces',
    'listDocuments',
  ]),
)
vi.mock('../components/spatial-editor/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/spatial-editor/index.js')>()
  const { CapturingSpatialEditor } = await import('../test-utils/capturing-spatial-editor.js')
  return { ...actual, SpatialEditor: CapturingSpatialEditor }
})

const BASE_URL = 'http://127.0.0.1:3099'
const SCOPE = daemonMemoryScope(BASE_URL, { workspaceId: 'w1' })
const LISTED = 'digest-in-listing'

let backend: FakeDocumentBackend | null = null

async function openDocument(): Promise<FakeDocumentBackend> {
  await act(async () => {
    rtlRender(
      <DaemonDocumentPage
        daemonBaseUrl={BASE_URL}
        createBackend={() => {
          backend = new FakeDocumentBackend()
          return backend
        }}
      />,
      { wrapper: MemoryRouterWrapper, container: document.body },
    )
  })
  await waitFor(() => expect(screen.getByTestId('stub-spatial-editor')).toBeTruthy())
  if (backend === null) throw new Error('the page created no backend')
  return backend
}

describe('DaemonDocumentPage remembers the open', () => {
  beforeEach(() => {
    window.localStorage.clear()
    resetCapturedEditorProps()
    backend = null
    vi.mocked(daemonApiClient.listWorkspaces).mockResolvedValue({
      workspaces: [{ workspaceId: 'w1' }],
    })
    vi.mocked(daemonApiClient.listDocuments).mockResolvedValue({
      documents: [
        {
          path: 'main',
          documentId: 'id-main',
          updatedAt: '2026-01-01',
          kind: 'spatial',
          contentDigest: LISTED,
        },
      ],
    })
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('puts a document opened by address in Recent with the listing digest as its baseline', async () => {
    await openDocument()
    await waitFor(() => expect(readRecentIds(SCOPE)).toContain('id-main'))
    await waitFor(() => expect(readSeenDigest(SCOPE, 'id-main')).toBe(LISTED))
  })
})
