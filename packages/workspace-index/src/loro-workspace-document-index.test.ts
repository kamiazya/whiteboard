/**
 * The tree-backed index, held to the port's own conformance suite — the same
 * one the in-memory, libSQL and IndexedDB indexes pass.
 *
 * That is the whole point of running it here: a workspace tree is a different
 * shape of storage from a table of rows, and the question worth answering is
 * whether it can still promise what the port promises. Where it cannot, the
 * suite says so rather than a comment claiming it does.
 */

import type { BlobRef, BlobStore } from '@kamiazya/whiteboard-ports'
import { describeDocumentIndexConformance } from '@kamiazya/whiteboard-ports/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe } from 'vitest'
import { LoroWorkspaceDocumentIndex } from './loro-workspace-document-index.js'
import type { WorkspaceDocs } from './workspace-docs.js'

/**
 * Workspace documents in memory.
 *
 * `save` is a no-op because these ARE the stored documents — nothing is
 * exported. A real backing store exports and writes there, which is exactly
 * the part this package does not decide.
 */
function inMemoryWorkspaceDocs(): WorkspaceDocs & {
  listWorkspaces(): Promise<{ workspaceId: string }[]>
} {
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
    async listWorkspaces() {
      return [...docs.keys()].map((workspaceId) => ({ workspaceId }))
    },
  }
}

/** Enough of a `BlobStore` for the evacuation a delete performs. */
function inMemoryBlobStore(): BlobStore {
  const blobs = new Map<string, Uint8Array>()
  const key = (ref: BlobRef) => `${ref.algorithm}:${ref.digestHex}`
  let next = 0
  return {
    async put({ bytes }) {
      // A counter, not a real digest: nothing here reads the ref back for its
      // content-addressing, and a fake keeps this double synchronous in spirit.
      next += 1
      const ref = { algorithm: 'sha-256', digestHex: String(next).padStart(64, '0') } as const
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
  }
}

describe('LoroWorkspaceDocumentIndex', () => {
  describeDocumentIndexConformance(async () => ({
    index: (() => {
      const docs = inMemoryWorkspaceDocs()
      return new LoroWorkspaceDocumentIndex(docs, inMemoryBlobStore(), docs)
    })(),
    dispose: async () => {},
  }))
})
