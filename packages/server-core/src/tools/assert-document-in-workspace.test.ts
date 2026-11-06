import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, it } from 'vitest'
import { assertDocumentInWorkspace } from './assert-document-in-workspace.js'
import { WorkspaceDocumentNotFoundError } from './document-crud.errors.js'

const HOME = '01ARZ3NDEKTSV4RRFFQ69G5FAW'

describe('assertDocumentInWorkspace', () => {
  async function indexWith(workspaceId: string, path: string) {
    const index = new InMemoryDocumentIndex()
    await index.createWorkspace({ workspaceId })
    const entry = await index.createDocument({ workspaceId, path, kind: 'spatial' })
    return { index, documentId: entry.documentId }
  }

  it('resolves when the document is registered under the given workspace', async () => {
    const { index, documentId } = await indexWith(HOME, 'doc-a')
    await expect(assertDocumentInWorkspace(index, HOME, documentId)).resolves.toBeUndefined()
  })

  it('throws WorkspaceDocumentNotFoundError when the document belongs to a different workspace', async () => {
    const { index, documentId } = await indexWith(HOME, 'doc-a')
    await index.createWorkspace({ workspaceId: '01ECWTM29HBA5A9MXS76EM7JHR' })
    // An id is a handle within a workspace, not a capability across them.
    await expect(
      assertDocumentInWorkspace(index, '01ECWTM29HBA5A9MXS76EM7JHR', documentId),
    ).rejects.toThrow(WorkspaceDocumentNotFoundError)
  })

  it('throws WorkspaceDocumentNotFoundError when the workspace holds nothing at all', async () => {
    const index = new InMemoryDocumentIndex()
    await expect(
      assertDocumentInWorkspace(index, HOME, '01ARZ3NDEKTSV4RRFFQ69G5FAV'),
    ).rejects.toThrow(WorkspaceDocumentNotFoundError)
  })
})
