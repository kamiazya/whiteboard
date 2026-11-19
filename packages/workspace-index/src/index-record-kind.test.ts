/**
 * What the index asks of the engine when the record is a lease: its writes are
 * unjudged, because the keeper judges what it is pushed, and every record it
 * opens is given back, because a lease the index never releases is a document
 * the engine holds for good.
 */
import { type CrdtEngine, createCrdtEngine } from '@kamiazya/whiteboard-loro-adapter'
import { InMemoryDocumentStore } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, it } from 'vitest'
import { RecordStoreWorkspaceDocs } from './document-store-workspace-docs.js'
import { leaseIndexKind } from './index-record-kind.js'
import { LoroWorkspaceDocumentIndex } from './loro-workspace-document-index.js'
import { inMemoryBlobStore, notRenamingRegistry } from './test-utils/index-subjects.js'

const WS = '01BSXMXYEPZGZYHNN3KTQZ33EE'

/** The real engine, remembering which handles are open and how each write and subtree import was judged. */
function watchedEngine() {
  const engine = createCrdtEngine()
  const open = new Set<number>()
  const judged: Array<string | undefined> = []
  const watched: CrdtEngine = {
    ...engine,
    open(request) {
      const response = engine.open(request)
      open.add(response.handle)
      return response
    },
    close(request) {
      open.delete(request.handle)
      engine.close(request)
    },
    write(request) {
      judged.push(request.judge)
      return engine.write(request)
    },
    importSubtree(request) {
      judged.push(request.judge)
      return engine.importSubtree(request)
    },
  }
  return { watched, open, judged }
}

describe('the index over engine leases', () => {
  it('writes unjudged and gives back every record it opens', async () => {
    const { watched, open, judged } = watchedEngine()
    const kind = leaseIndexKind(async () => watched)
    const docs = new RecordStoreWorkspaceDocs(new InMemoryDocumentStore(), kind)
    const index = new LoroWorkspaceDocumentIndex(docs, inMemoryBlobStore(), notRenamingRegistry, {
      kind,
    })

    await index.createWorkspace({ workspaceId: WS })
    const { documentId } = await index.createDocument({
      workspaceId: WS,
      path: 'a/b',
      kind: 'markdown',
    })
    await index.moveDocument({ workspaceId: WS, from: 'a/b', to: 'c' })
    await index.deleteDocument({ workspaceId: WS, path: 'c' })
    expect(await index.restoreDocument({ workspaceId: WS, documentId })).not.toBeNull()
    await index.listDocuments({ workspaceId: WS })

    // The subject is present: creates, a move, a delete and a restore all wrote.
    expect(judged.length).toBeGreaterThanOrEqual(5)
    expect(judged.every((judge) => judge === 'none')).toBe(true)
    expect([...open]).toEqual([])
  })
})
