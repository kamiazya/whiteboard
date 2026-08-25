/**
 * The tree-backed index, held to the port's own conformance suite — the same
 * one the in-memory, libSQL and IndexedDB indexes pass.
 *
 * That is the whole point of running it here: a workspace tree is a different
 * shape of storage from a table of rows, and the question worth answering is
 * whether it can still promise what the port promises. Where it cannot, the
 * suite says so rather than a comment claiming it does.
 */

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
function inMemoryWorkspaceDocs(): WorkspaceDocs {
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
    async save() {},
  }
}

describe('LoroWorkspaceDocumentIndex', () => {
  describeDocumentIndexConformance(async () => ({
    index: new LoroWorkspaceDocumentIndex(inMemoryWorkspaceDocs()),
    dispose: async () => {},
  }))
})
