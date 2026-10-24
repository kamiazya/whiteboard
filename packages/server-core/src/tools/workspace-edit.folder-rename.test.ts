import type { DocumentFolders, SetFolderNameInput } from '@kamiazya/whiteboard-ports'
import { DisplayNameTakenError } from '@kamiazya/whiteboard-ports'
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, it } from 'vitest'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createWorkspaceEditTool, workspaceEditInputSchema } from './workspace-edit.js'

const WS = 'ws-folders'

/** An index that names folders and records what it was asked, refusing one taken name. */
function namingIndex() {
  const calls: SetFolderNameInput[] = []
  const folders: DocumentFolders = {
    listFolderNames: async () => [],
    setFolderName: async (input) => {
      if (input.name === 'Taken') throw new DisplayNameTakenError('folder', input.path, input.name)
      calls.push(input)
    },
  }
  return { index: Object.assign(new InMemoryDocumentIndex(), folders), calls }
}

async function toolOver(documentIndex: InMemoryDocumentIndex) {
  await documentIndex.createWorkspace({ workspaceId: WS })
  return createWorkspaceEditTool(makeTestDeps({ documentIndex }))
}

describe('wb_workspace_edit folder.rename', () => {
  it('names a folder through the index and reports the path it named', async () => {
    const { index, calls } = namingIndex()
    const tool = await toolOver(index)

    const out = await tool.execute({
      workspaceId: WS,
      ops: [{ op: 'folder.rename', path: 'week-6', name: 'Week 6' }],
    })

    expect(out.results).toEqual([{ op: 'folder.rename', path: 'week-6' }])
    expect(calls).toEqual([{ workspaceId: WS, path: 'week-6', name: 'Week 6' }])
  })

  it('clears a name when the op carries none', async () => {
    const { index, calls } = namingIndex()
    const tool = await toolOver(index)

    await tool.execute({ workspaceId: WS, ops: [{ op: 'folder.rename', path: 'week-6' }] })

    expect(calls).toEqual([{ workspaceId: WS, path: 'week-6' }])
  })

  it('stops the batch at a name a sibling folder already shows, saying so', async () => {
    const { index } = namingIndex()
    const tool = await toolOver(index)

    await expect(
      tool.execute({
        workspaceId: WS,
        ops: [{ op: 'folder.rename', path: 'week-6', name: 'Taken' }],
      }),
    ).rejects.toThrow(/ops\[0\] \(folder\.rename\).*already called "Taken"/)
  })

  it('refuses a keeper that names no folders, in words', async () => {
    const tool = await toolOver(new InMemoryDocumentIndex())
    await expect(
      tool.execute({
        workspaceId: WS,
        ops: [{ op: 'folder.rename', path: 'week-6', name: 'Week 6' }],
      }),
    ).rejects.toThrow(/does not name folders/)
  })

  it.each([['a/b'], ['   ']])('refuses the folder name %j at the boundary', (name) => {
    const parsed = workspaceEditInputSchema.safeParse({
      workspaceId: WS,
      ops: [{ op: 'folder.rename', path: 'week-6', name }],
    })
    expect(parsed.success).toBe(false)
  })
})
