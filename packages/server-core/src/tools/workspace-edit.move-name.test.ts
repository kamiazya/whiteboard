import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, it } from 'vitest'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createWorkspaceEditTool } from './workspace-edit.js'

const WS = '01YCET6QF891JPFBD21Y9DPHK0'

describe('wb_workspace_edit document.move onto a sibling name', () => {
  it('stops the batch saying which name is taken, and leaves the document where it was', async () => {
    const documentIndex = new InMemoryDocumentIndex()
    await documentIndex.createWorkspace({ workspaceId: WS })
    await documentIndex.createDocument({
      workspaceId: WS,
      path: 'week/plan',
      kind: 'markdown',
      name: 'Plan',
    })
    const moving = await documentIndex.createDocument({
      workspaceId: WS,
      path: 'month/x',
      kind: 'markdown',
      name: 'plan',
    })
    const tool = createWorkspaceEditTool(makeTestDeps({ documentIndex }))

    await expect(
      tool.execute({
        workspaceId: WS,
        ops: [{ op: 'document.move', documentId: moving.documentId, path: 'week/x' }],
      }),
    ).rejects.toThrow(/ops\[0\] \(document\.move\).*already called "Plan"/)
    expect(
      (await documentIndex.resolveDocumentById({ workspaceId: WS, documentId: moving.documentId }))
        ?.path,
    ).toBe('month/x')
  })
})
