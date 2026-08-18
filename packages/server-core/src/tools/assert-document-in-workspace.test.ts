import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, it } from 'vitest'
import { assertDocumentInWorkspace } from './assert-document-in-workspace.js'
import { WorkspaceDocumentNotFoundError } from './document-crud.errors.js'

describe('assertDocumentInWorkspace', () => {
  async function indexWith(workspaceId: string, path: string) {
    const index = new InMemoryDocumentIndex()
    await index.createWorkspace({ workspaceId })
    const entry = await index.createDocument({ workspaceId, path, kind: 'spatial' })
    return { index, documentId: entry.documentId }
  }

  it('resolves when the document is registered under the given workspace', async () => {
    const { index, documentId } = await indexWith('ws-1', 'doc-a')
    await expect(assertDocumentInWorkspace(index, 'ws-1', documentId)).resolves.toBeUndefined()
  })

  it('throws WorkspaceDocumentNotFoundError when the document belongs to a different workspace', async () => {
    const { index, documentId } = await indexWith('ws-a', 'doc-a')
    await index.createWorkspace({ workspaceId: 'ws-b' })
    // An id is a handle within a workspace, not a capability across them.
    await expect(assertDocumentInWorkspace(index, 'ws-b', documentId)).rejects.toThrow(
      WorkspaceDocumentNotFoundError,
    )
  })

  it('throws WorkspaceDocumentNotFoundError when the workspace holds nothing at all', async () => {
    const index = new InMemoryDocumentIndex()
    await expect(
      assertDocumentInWorkspace(index, 'ws-1', '01ARZ3NDEKTSV4RRFFQ69G5FAV'),
    ).rejects.toThrow(WorkspaceDocumentNotFoundError)
  })
})
