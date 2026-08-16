import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-canvas-ports/test-utils'
import { describe, expect, it } from 'vitest'
import { assertCanvasInWorkspace } from './assert-canvas-in-workspace.js'
import { CanvasNotFoundError } from './canvas-crud.errors.js'

describe('assertCanvasInWorkspace', () => {
  async function indexWith(workspaceId: string, path: string) {
    const index = new InMemoryDocumentIndex()
    await index.createWorkspace({ workspaceId })
    const entry = await index.createDocument({ workspaceId, path, kind: 'spatial' })
    return { index, documentId: entry.documentId }
  }

  it('resolves when the document is registered under the given workspace', async () => {
    const { index, documentId } = await indexWith('ws-1', 'doc-a')
    await expect(assertCanvasInWorkspace(index, 'ws-1', documentId)).resolves.toBeUndefined()
  })

  it('throws CanvasNotFoundError when the document belongs to a different workspace', async () => {
    const { index, documentId } = await indexWith('ws-a', 'doc-a')
    await index.createWorkspace({ workspaceId: 'ws-b' })
    // An id is a handle within a workspace, not a capability across them.
    await expect(assertCanvasInWorkspace(index, 'ws-b', documentId)).rejects.toThrow(
      CanvasNotFoundError,
    )
  })

  it('throws CanvasNotFoundError when the workspace holds nothing at all', async () => {
    const index = new InMemoryDocumentIndex()
    await expect(
      assertCanvasInWorkspace(index, 'ws-1', '01ARZ3NDEKTSV4RRFFQ69G5FAV'),
    ).rejects.toThrow(CanvasNotFoundError)
  })
})
