/**
 * Delete evacuates before it removes, and restore brings the document back
 * under the id it had.
 *
 * This is the pair the design marked as inseparable from the index itself: a
 * deleted tree node cannot be moved back and a shallow snapshot drops its
 * content, so a delete that ships WITHOUT the evacuation destroys anything it
 * touches in the window before the evacuation is added. There is no state to
 * migrate afterwards — the bytes are simply gone.
 */

import { readSpatialCanvas, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { BlobRef, BlobStore } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it } from 'vitest'
import { LoroWorkspaceDocumentIndex } from './loro-workspace-document-index.js'
import type { WorkspaceDocs } from './workspace-docs.js'

const WS = 'ws-trash'

function inMemoryBlobStore(): BlobStore & { size: () => number } {
  const blobs = new Map<string, Uint8Array>()
  const key = (ref: BlobRef) => `${ref.algorithm}:${ref.digestHex}`
  let next = 0
  return {
    async put({ bytes }) {
      // A counter rather than a real digest. Content-addressing is the blob
      // store's promise, not this suite's subject, and hashing here would
      // pull DOM types into a package that has none.
      next += 1
      const digestHex = String(next).padStart(64, '0')
      const ref = { algorithm: 'sha-256', digestHex } as const
      blobs.set(key(ref), new Uint8Array(bytes))
      return { ref }
    },
    async get({ ref }) {
      const bytes = blobs.get(key(ref))
      return bytes === undefined ? null : { bytes: new Uint8Array(bytes) }
    },
    async has({ ref }) {
      return { exists: blobs.has(key(ref)) }
    },
    async delete({ ref }) {
      blobs.delete(key(ref))
    },
    size: () => blobs.size,
  }
}

function inMemoryWorkspaceDocs(): WorkspaceDocs & { peek: (id: string) => LoroDoc } {
  const docs = new Map<string, LoroDoc>()
  let nextPeer = 1n
  return {
    async open(workspaceId) {
      return docs.get(workspaceId) ?? null
    },
    async create(workspaceId) {
      const existing = docs.get(workspaceId)
      if (existing !== undefined) return existing
      const doc = new LoroDoc()
      doc.setPeerId(nextPeer)
      nextPeer += 1n
      docs.set(workspaceId, doc)
      return doc
    },
    async save() {
      return null
    },
    // These doubles serve INDEX tests, which never tail. Rejecting rather than
    // answering an empty cursor: a silent no-op would let a tailing test pass
    // against a double that cannot tail.
    readCursor: () => Promise.reject(new Error('not implemented')),
    catchUp: () => Promise.reject(new Error('not implemented')),
    peek: (id) => docs.get(id) as LoroDoc,
  }
}

describe('deleting a document', () => {
  let blobs: ReturnType<typeof inMemoryBlobStore>
  let docs: ReturnType<typeof inMemoryWorkspaceDocs>
  let index: LoroWorkspaceDocumentIndex

  beforeEach(async () => {
    blobs = inMemoryBlobStore()
    docs = inMemoryWorkspaceDocs()
    index = new LoroWorkspaceDocumentIndex(docs, blobs, { listWorkspaces: async () => [] })
    await index.createWorkspace({ workspaceId: WS })
  })

  async function seedCanvas(path: string, text: string): Promise<string> {
    const created = await index.createDocument({ workspaceId: WS, path, kind: 'spatial' })
    writeSpatialCanvas(index.documentContainers(docs.peek(WS), created.documentId), {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 80, height: 40, text }],
      edges: [],
    })
    return created.documentId
  }

  it('evacuates the content before removing it, and lists it as recoverable', async () => {
    const documentId = await seedCanvas('design', 'important')

    await index.deleteDocument({ workspaceId: WS, path: 'design' })

    expect(await index.resolveDocument({ workspaceId: WS, path: 'design' })).toBeNull()
    const trashed = await index.listTrash({ workspaceId: WS })
    expect(trashed).toHaveLength(1)
    expect(trashed[0]?.documentId).toBe(documentId)
    expect(trashed[0]?.path).toBe('design')
    // The bytes are really there, not merely a row claiming they are.
    expect(blobs.size()).toBe(1)
  })

  it('restores the document under the id it had, so a share link survives', async () => {
    const documentId = await seedCanvas('design', 'important')
    await index.deleteDocument({ workspaceId: WS, path: 'design' })

    const restored = await index.restoreDocument({ workspaceId: WS, documentId })

    expect(restored?.documentId).toBe(documentId)
    expect(await index.resolveDocumentById({ workspaceId: WS, documentId })).not.toBeNull()
    // Content, not just placement.
    const node = readSpatialCanvas(index.documentContainers(docs.peek(WS), documentId)).nodes[0]
    expect(node?.type === 'text' ? node.text : null).toBe('important')
    // Off the trash listing once it is back.
    expect(await index.listTrash({ workspaceId: WS })).toHaveLength(0)
  })

  it('does not evacuate when the delete is refused', async () => {
    await seedCanvas('design', 'parent')
    await seedCanvas('design/notes', 'child')

    await expect(index.deleteDocument({ workspaceId: WS, path: 'design' })).rejects.toThrow()

    // Nothing was written: a refused delete that had already evacuated would
    // leave a blob and a trash row for a document that is still there.
    expect(blobs.size()).toBe(0)
    expect(await index.listTrash({ workspaceId: WS })).toHaveLength(0)
  })

  it('leaves nothing behind when a document is deleted twice', async () => {
    await seedCanvas('design', 'important')
    await index.deleteDocument({ workspaceId: WS, path: 'design' })
    // The port says deleting an absent path succeeds. It must not also
    // evacuate nothing into a second trash row.
    await index.deleteDocument({ workspaceId: WS, path: 'design' })

    expect(await index.listTrash({ workspaceId: WS })).toHaveLength(1)
  })
})
