/**
 * The `[[` completion's "Create '<path>'" row exists only when the page hands
 * the editor a creator. The daemon keeper must supply one, and it must make a
 * markdown note without navigating away from the document being written.
 */

import {
  writeCoreFacets,
  writeDocumentKind,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { cleanup, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import { FakeDocumentBackend, renderInRouter } from '../test-utils/daemon-page-harness.js'

vi.mock('../lib/daemon-api-client.js', async (importOriginal) =>
  (await import('../test-utils/daemon-page-harness.js')).daemonApiClientMock(importOriginal, [
    'listWorkspaces',
    'listDocuments',
    'createDocument',
  ]),
)

const captured = vi.hoisted(() => ({
  create: undefined as ((path: string, name: string) => Promise<void>) | undefined,
}))

vi.mock('../components/markdown-editor/MarkdownEditor.js', () => ({
  MarkdownEditor: (props: {
    onCreateLinkTarget?: (path: string, name: string) => Promise<void>
  }) => {
    captured.create = props.onCreateLinkTarget
    return <div data-testid="markdown-stub" />
  },
}))

vi.mock('../lib/replica-refresh.js', async () =>
  (await import('../test-utils/daemon-page-harness.js')).replicaRefreshMock(),
)

const { DaemonDocumentPage } = await import('./DaemonDocumentPage.js')

const mockListWorkspaces = vi.mocked(daemonApiClient.listWorkspaces)
const mockListDocuments = vi.mocked(daemonApiClient.listDocuments)
const mockCreateDocument = vi.mocked(daemonApiClient.createDocument)

function markdownSnapshot(): Uint8Array {
  const doc = new LoroDoc()
  writeMarkdownBody(doc, '# Hi')
  writeCoreFacets(doc, { type: 'markdown' })
  writeDocumentKind(doc, 'markdown')
  return doc.export({ mode: 'snapshot' })
}

describe('DaemonDocumentPage link-target creation', () => {
  beforeEach(() => {
    captured.create = undefined
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListDocuments.mockResolvedValue({
      documents: [
        { path: 'note', documentId: 'id-note', updatedAt: '2026-01-01', kind: 'markdown' },
      ],
    })
    mockCreateDocument.mockResolvedValue(
      {} as Awaited<ReturnType<typeof daemonApiClient.createDocument>>,
    )
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('hands the editor a creator that makes a markdown note at the typed path', async () => {
    renderInRouter(
      <DaemonDocumentPage
        daemonBaseUrl="http://127.0.0.1:3099"
        workspaceId="w1"
        path="note"
        createBackend={() => new FakeDocumentBackend(markdownSnapshot)}
      />,
    )
    await screen.findByTestId('markdown-stub', undefined, { timeout: 10_000 })
    await waitFor(() => expect(captured.create).toBeTypeOf('function'))

    await captured.create?.('projects/new-idea', 'New idea')

    expect(mockCreateDocument).toHaveBeenCalledTimes(1)
    const args = mockCreateDocument.mock.calls[0]
    expect(args?.slice(2)).toEqual(['w1', 'projects/new-idea', 'markdown', 'New idea'])
  }, 30_000)
})
