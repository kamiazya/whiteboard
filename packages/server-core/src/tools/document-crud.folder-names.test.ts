import type { DocumentFolders } from '@kamiazya/whiteboard-ports'
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, it } from 'vitest'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { wbDocumentList } from './document-crud.js'
import { wbDocumentListOutputSchema } from './document-crud.schemas.js'

const WS = '01ZVM89A4A1V9FS03Z9J64KEK1'

async function depsNaming(named: { path: string; name: string }[]) {
  const folders: DocumentFolders = {
    listFolderNames: async () => named,
    setFolderName: async () => {},
  }
  const documentIndex = Object.assign(new InMemoryDocumentIndex(), folders)
  await documentIndex.createWorkspace({ workspaceId: WS })
  return makeTestDeps({ documentIndex })
}

describe('wbDocumentList folderNames', () => {
  it('reports each named folder beside the documents, and the output schema accepts it', async () => {
    const deps = await depsNaming([{ path: 'week-6', name: 'Week 6' }])

    const out = await wbDocumentList(deps, { workspaceId: WS })

    expect(out.folderNames).toEqual([{ path: 'week-6', name: 'Week 6' }])
    expect(wbDocumentListOutputSchema.safeParse(out).success).toBe(true)
  })

  it('omits the field when no folder is named', async () => {
    const deps = await depsNaming([])

    expect(await wbDocumentList(deps, { workspaceId: WS })).not.toHaveProperty('folderNames')
  })

  it('omits the field when the index keeps no folder names', async () => {
    const documentIndex = new InMemoryDocumentIndex()
    await documentIndex.createWorkspace({ workspaceId: WS })
    const deps = makeTestDeps({ documentIndex })

    expect(await wbDocumentList(deps, { workspaceId: WS })).not.toHaveProperty('folderNames')
  })
})
