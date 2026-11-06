// @vitest-environment node
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
 * `localEdit` is that effect in the contract's terms: a node written against
 * the delivered snapshot, landed once the store holds it.
 */
import type { DocumentBackendHarness } from '@kamiazya/whiteboard-daemon-client/test-utils/document-backend-contract'
import { documentBackendContract } from '@kamiazya/whiteboard-daemon-client/test-utils/document-backend-contract'
import {
  documentContainers,
  readSpatialCanvas,
  writeSpatialNode,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { LoroDoc } from 'loro-crdt'
import { describe } from 'vitest'
import { BrowserBackend } from './browser-backend.js'

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

  async save(_workspaceId: string, doc: LoroDoc): Promise<Uint8Array | null> {
    this.stored = new Uint8Array(doc.export({ mode: 'snapshot' }))
    return this.stored
  }

  // This double keeps one snapshot and no log, so there is no position to
  // hold and nothing to tail. Rejecting rather than answering an empty
  // cursor: a silent no-op would let a tailing test pass against a double
  // that cannot tail.
  async readCursor(): Promise<never> {
    throw new Error('not implemented')
  }

  async catchUp(): Promise<never> {
    throw new Error('not implemented')
  }
}

function createStores() {
  const docs = new InMemoryWorkspaceDocs()

  return { docs }
}

describe('DocumentBackend contract: BrowserBackend', () => {
  documentBackendContract((): DocumentBackendHarness => {
    const { docs } = createStores()
    const backend = new BrowserBackend(
      { documentId: DOC_ID, path: 'design', kind: 'spatial' },
      docs,
    )
    return {
      backend,
      localEdit: (snapshot) => {
        const doc = new LoroDoc()
        if (snapshot !== null) doc.import(snapshot)
        const from = doc.version()
        writeSpatialNode(
          documentContainers(doc, DOC_ID),
          textNode({ id: 'n-last', x: 0, y: 0, width: 80, height: 40, text: 'last' }),
        )
        return {
          bytes: doc.export({ mode: 'update', from }),
          landed: async () => {
            const stored = await docs.open(DOC_ID)
            if (stored === null) return false
            const canvas = readSpatialCanvas(documentContainers(stored, DOC_ID))
            return canvas.nodes.some((n) => n.id === 'n-last')
          },
        }
      },
      cleanup: () => backend.disconnect(),
    }
  })
})
