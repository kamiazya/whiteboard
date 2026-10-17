/**
 * A workspace holds at most 2000 documents, and every way this index places a
 * NEW one — create, duplicate, restore from the trash — refuses past it. Both
 * keepers place through this class, so the ceiling the sync path holds is
 * held here as well.
 */

import {
  readTrashEntries,
  readWorkspaceDocuments,
  WORKSPACE_TREE_KEY,
} from '@kamiazya/whiteboard-loro-adapter'
import { type BlobStore, blobRefKey } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it } from 'vitest'
import { LoroWorkspaceDocumentIndex } from './loro-workspace-document-index.js'
import type { WorkspaceDocs } from './workspace-docs.js'

/** Written out rather than imported, so the test is not judged by the constant it judges. */
const CEILING = 2000
const WS = 'ws-ceiling'

const notImplemented = (): Promise<never> => Promise.reject(new Error('not implemented'))

function inMemoryBlobStore(): BlobStore {
  const blobs = new Map<string, Uint8Array>()
  let next = 0
  return {
    async put({ bytes }) {
      next += 1
      const ref = { algorithm: 'sha-256', digestHex: String(next).padStart(64, '0') } as const
      blobs.set(blobRefKey(ref), new Uint8Array(bytes))
      return { ref }
    },
    async get({ ref }) {
      const bytes = blobs.get(blobRefKey(ref))
      return bytes === undefined ? null : { bytes: new Uint8Array(bytes) }
    },
    async has({ ref }) {
      return { exists: blobs.has(blobRefKey(ref)) }
    },
    async delete({ ref }) {
      blobs.delete(blobRefKey(ref))
    },
  }
}

function inMemoryWorkspaceDocs(): WorkspaceDocs & { peek: (id: string) => LoroDoc } {
  const docs = new Map<string, LoroDoc>()
  return {
    async open(workspaceId) {
      return docs.get(workspaceId) ?? null
    },
    async create(workspaceId) {
      const doc = docs.get(workspaceId) ?? new LoroDoc()
      docs.set(workspaceId, doc)
      return doc
    },
    async save() {
      return null
    },
    readCursor: notImplemented,
    catchUp: notImplemented,
    peek: (id) => docs.get(id) as LoroDoc,
  }
}

/** `n` in the ULID alphabet, so a seeded id is canonical. */
function crockford(n: number): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let out = ''
  let rest = n
  do {
    out = alphabet[rest % 32] + out
    rest = Math.floor(rest / 32)
  } while (rest > 0)
  return out
}

/**
 * Fills the record up to `total` documents with raw tree nodes — what a
 * thousand creates would leave, without paying for a thousand writes.
 */
function fillTo(doc: LoroDoc, total: number): void {
  const tree = doc.getTree(WORKSPACE_TREE_KEY)
  for (let i = readWorkspaceDocuments(doc).length; i < total; i++) {
    const node = tree.createNode()
    node.data.set('documentId', `01BRWC${crockford(i).padStart(20, '0')}`)
    node.data.set('segment', `filler-${i}`)
    node.data.set('kind', 'markdown')
    node.data.set('createdAt', 1_000)
    node.data.set('updatedAt', 1_000)
  }
  doc.commit()
}

describe('a workspace at its document ceiling', () => {
  let docs: ReturnType<typeof inMemoryWorkspaceDocs>
  let index: LoroWorkspaceDocumentIndex

  beforeEach(async () => {
    docs = inMemoryWorkspaceDocs()
    index = new LoroWorkspaceDocumentIndex(docs, inMemoryBlobStore(), {
      listWorkspaces: async () => [],
      renameWorkspace: notImplemented,
    })
    await index.createWorkspace({ workspaceId: WS })
  })

  const held = () => readWorkspaceDocuments(docs.peek(WS)).length

  it('still creates the document that reaches the ceiling', async () => {
    fillTo(docs.peek(WS), CEILING - 1)
    await index.createDocument({ workspaceId: WS, path: 'last', kind: 'markdown' })
    expect(held()).toBe(CEILING)
  })

  it('refuses to create one more', async () => {
    fillTo(docs.peek(WS), CEILING)
    await expect(
      index.createDocument({ workspaceId: WS, path: 'one-more', kind: 'markdown' }),
    ).rejects.toMatchObject({ code: 'too_many_documents', status: 413 })
    expect(held()).toBe(CEILING)
  })

  it('refuses to duplicate one', async () => {
    await index.createDocument({ workspaceId: WS, path: 'source', kind: 'markdown' })
    fillTo(docs.peek(WS), CEILING)
    await expect(
      index.duplicateDocument({ workspaceId: WS, path: 'source' }),
    ).rejects.toMatchObject({ code: 'too_many_documents', status: 413 })
    expect(held()).toBe(CEILING)
  })

  it('refuses to restore one from the trash, and keeps the trash row', async () => {
    const { documentId } = await index.createDocument({
      workspaceId: WS,
      path: 'victim',
      kind: 'markdown',
    })
    await index.deleteDocument({ workspaceId: WS, path: 'victim' })
    fillTo(docs.peek(WS), CEILING)
    await expect(index.restoreDocument({ workspaceId: WS, documentId })).rejects.toMatchObject({
      code: 'too_many_documents',
      status: 413,
    })
    expect(held()).toBe(CEILING)
    expect(readTrashEntries(docs.peek(WS)).map((row) => row.documentId)).toEqual([documentId])
  })
})
