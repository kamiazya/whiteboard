/**
 * The browser implementation against the shared DocumentBackend contract.
 * Its transport siblings run the same cases from mcp-server, where they live.
 *
 * In-memory stores rather than real IndexedDB: the contract is about what a
 * caller of the port may rely on, and the persistence layer has its own
 * browser-mode suite (`browser-backend.browser.test.tsx`).
 *
 * No `sentUpdates` in this harness, deliberately: this backend's upstream is
 * the workspace document, so a pushed update is imported and its EFFECT
 * persisted — the input bytes never travel anywhere to be observed. The
 * contract's send case skips, and the effect-based equivalent lives in the
 * browser-mode suite ("a pushed edit lands on the document tree node").
 */
import type { DocumentBackendHarness } from '@kamiazya/whiteboard-mcp/document-backend-contract-suite'
import { documentBackendContract } from '@kamiazya/whiteboard-mcp/document-backend-contract-suite'
import type { WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { LoroDoc } from 'loro-crdt'
import { describe } from 'vitest'
import { BrowserBackend } from './browser-backend.js'
import type { DocumentFileStore } from './document-file-store.js'
import type { LoroStore } from './loro-store.js'

const DOC_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

class InMemoryWorkspaceDocs implements WorkspaceDocs {
  private stored: Uint8Array | null = null

  async open(_workspaceId: string): Promise<LoroDoc | null> {
    if (this.stored === null) return null
    const doc = new LoroDoc()
    doc.import(this.stored)
    return doc
  }

  async create(workspaceId: string): Promise<LoroDoc> {
    const existing = await this.open(workspaceId)
    if (existing !== null) return existing
    const doc = new LoroDoc()
    await this.save(workspaceId, doc)
    return doc
  }

  async save(_workspaceId: string, doc: LoroDoc): Promise<void> {
    this.stored = new Uint8Array(doc.export({ mode: 'snapshot' }))
  }
}

function createStores() {
  const docs = new InMemoryWorkspaceDocs()

  // No legacy per-document records in this harness — every load is a miss.
  const legacy = {
    load: async (_documentId: string) => ({ kind: 'not-found' }) as const,
  } as unknown as LoroStore

  const files = new Map<string, { mimeType: string; blob: Blob }>()
  const fileStore = {
    get: async (fileId: string) => files.get(fileId)?.blob ?? null,
    put: async (fileId: string, record: { mimeType: string; blob: Blob }) => {
      files.set(fileId, record)
    },
  } as unknown as DocumentFileStore

  return { docs, legacy, fileStore }
}

describe('DocumentBackend contract: BrowserBackend', () => {
  documentBackendContract((): DocumentBackendHarness => {
    const { docs, legacy, fileStore } = createStores()
    const backend = new BrowserBackend(
      { documentId: DOC_ID, path: 'design', kind: 'spatial' },
      docs,
      fileStore,
      legacy,
    )
    return { backend, cleanup: () => backend.disconnect() }
  })
})
