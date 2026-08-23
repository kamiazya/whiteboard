import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, it } from 'vitest'
import { createInMemoryDocumentStore } from '../test-utils/in-memory-document-store.js'
import { createDocumentGetTool } from './document-get.js'
import { createWorkspaceEditTool } from './workspace-edit.js'

const WS = 'batch'

function makeDeps() {
  return {
    documentStore: createInMemoryDocumentStore(),
    blobStore: {} as never,
    documentIndex: new InMemoryDocumentIndex(),
  }
}
const body = (text: string) => `---\ntype: note\n---\n${text}`

describe('wb_workspace_edit', () => {
  it('creates several documents in one call and reports the ids it minted', async () => {
    const deps = makeDeps()
    const out = await createWorkspaceEditTool(deps).execute({
      workspaceId: WS,
      createWorkspace: true,
      ops: [
        { op: 'document.create', path: 'a', kind: 'markdown', name: 'A', markdown: body('one') },
        { op: 'document.create', path: 'b', kind: 'markdown', name: 'B', markdown: body('two') },
        { op: 'document.create', path: 'c', kind: 'spatial', name: 'C' },
      ],
    })
    expect(out.applied).toBe(3)
    expect(out.results).toHaveLength(3)
    // Without the ids coming back, a caller spends a round trip getting
    // them — which is the cost this tool exists to remove.
    for (const r of out.results) expect(r.documentId).toBeTruthy()

    const read = createDocumentGetTool(deps)
    const first = await read.execute({
      workspaceId: WS,
      documentId: out.results[0]?.documentId ?? '',
    })
    expect(first.content).toContain('one')
  })

  it('stops at the failing op and says how far it got', async () => {
    const deps = makeDeps()
    const tool = createWorkspaceEditTool(deps)
    await tool.execute({
      workspaceId: WS,
      createWorkspace: true,
      ops: [{ op: 'document.create', path: 'taken', kind: 'markdown' }],
    })

    // Documents live in their own Loro docs, so a batch spanning several of
    // them cannot be one atomic save the way `wb_canvas_edit` is. The
    // contract is therefore NOT "nothing was written" — it is "these ran,
    // this one failed, the rest did not". Saying "nothing was written"
    // here would be a lie a caller would act on.
    await expect(
      tool.execute({
        workspaceId: WS,
        ops: [
          { op: 'document.create', path: 'fresh', kind: 'markdown', markdown: body('kept') },
          { op: 'document.create', path: 'taken', kind: 'markdown' },
          { op: 'document.create', path: 'never', kind: 'markdown' },
        ],
      }),
    ).rejects.toThrow(/ops\[1\]/)

    const listed = await deps.documentIndex.listDocuments({ workspaceId: WS })
    const paths = listed.map((d) => d.path)
    expect(paths).toContain('fresh') // op 0 ran and stands
    expect(paths).not.toContain('never') // op 2 never ran
  })

  it('names how many ops succeeded in the message, since only .message survives MCP', async () => {
    const deps = makeDeps()
    const tool = createWorkspaceEditTool(deps)
    await tool.execute({
      workspaceId: WS,
      createWorkspace: true,
      ops: [{ op: 'document.create', path: 'dup', kind: 'markdown' }],
    })
    await expect(
      tool.execute({
        workspaceId: WS,
        ops: [
          { op: 'document.create', path: 'ok-1', kind: 'markdown' },
          { op: 'document.create', path: 'dup', kind: 'markdown' },
        ],
      }),
    ).rejects.toThrow(/1 op\(s\) before it were applied and stand/)
  })

  it('deletes and sets alongside creates', async () => {
    const deps = makeDeps()
    const tool = createWorkspaceEditTool(deps)
    const made = await tool.execute({
      workspaceId: WS,
      createWorkspace: true,
      ops: [{ op: 'document.create', path: 'edit-me', kind: 'markdown', markdown: body('before') }],
    })
    const documentId = made.results[0]?.documentId ?? ''
    await tool.execute({
      workspaceId: WS,
      ops: [
        { op: 'document.set', documentId, markdown: body('after') },
        { op: 'document.create', path: 'doomed', kind: 'markdown' },
      ],
    })
    const read = await createDocumentGetTool(deps).execute({ workspaceId: WS, documentId })
    expect(read.content).toContain('after')

    const listed = await deps.documentIndex.listDocuments({ workspaceId: WS })
    const doomed = listed.find((d) => d.path === 'doomed')
    await tool.execute({
      workspaceId: WS,
      ops: [{ op: 'document.delete', documentId: doomed?.documentId ?? '' }],
    })
    const after = await deps.documentIndex.listDocuments({ workspaceId: WS })
    expect(after.map((d) => d.path)).not.toContain('doomed')
  })
})
