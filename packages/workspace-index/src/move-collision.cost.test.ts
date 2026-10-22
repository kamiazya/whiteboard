/**
 * A move's collision check must cost one pass over the record's nodes, not
 * one per folder: a record may hold 4000 folders beside 2000 documents, and a
 * pairwise check is 24 million prefix tests on every move, paid before the
 * move is refused or made.
 *
 * Counted rather than timed — every prefix test is a call of the model's
 * `isSelfOrDescendant`.
 */
import { WORKSPACE_TREE_KEY } from '@kamiazya/whiteboard-loro-adapter'
import { type BlobStore, blobRefKey } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceDocs } from './workspace-docs.js'

// lazy-import: the index is imported after `vi.mock` wraps the prefix test,
// so the calls it makes are the ones this file counts.
const counted = vi.hoisted(() => ({ calls: 0 }))
vi.mock('@kamiazya/whiteboard-model', async (original) => {
  const actual = await original<typeof import('@kamiazya/whiteboard-model')>()
  return {
    ...actual,
    isSelfOrDescendant: (path: string, ancestor: string) => {
      counted.calls += 1
      return actual.isSelfOrDescendant(path, ancestor)
    },
  }
})

const WS = 'ws-move-cost'
const FOLDERS = 2000
const DOCUMENTS = 500

const notImplemented = (): Promise<never> => Promise.reject(new Error('not implemented'))

function inMemoryBlobStore(): BlobStore {
  const blobs = new Map<string, Uint8Array>()
  return {
    async put({ bytes }) {
      const ref = { algorithm: 'sha-256', digestHex: '0'.repeat(64) } as const
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

describe('a move in a record holding many folders', () => {
  it('tests each node against a prefix a bounded number of times', async () => {
    const { LoroWorkspaceDocumentIndex } = await import('./loro-workspace-document-index.js')
    const docs = inMemoryWorkspaceDocs()
    const index = new LoroWorkspaceDocumentIndex(docs, inMemoryBlobStore(), {
      listWorkspaces: async () => [],
      findWorkspace: async () => null,
      renameWorkspace: notImplemented,
    })
    await index.createWorkspace({ workspaceId: WS })
    for (let i = 0; i < DOCUMENTS; i++) {
      await index.createDocument({ workspaceId: WS, path: `docs/d${i}`, kind: 'markdown' })
    }
    const tree = docs.peek(WS).getTree(WORKSPACE_TREE_KEY)
    for (let i = 0; i < FOLDERS; i++) tree.createNode().data.set('segment', `f${i}`)
    docs.peek(WS).commit()
    const nodes = FOLDERS + DOCUMENTS + 1

    counted.calls = 0
    await index.moveDocument({ workspaceId: WS, from: 'docs/d0', to: 'moved' })

    // The subject is present: the move does test prefixes.
    expect(counted.calls).toBeGreaterThan(0)
    expect(counted.calls).toBeLessThanOrEqual(4 * nodes)
  }, 120_000)
})
