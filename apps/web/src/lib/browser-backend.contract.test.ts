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
import { LoroDoc } from 'loro-crdt'
import { describe } from 'vitest'
import { InMemoryRecordDocs } from '../test-utils/in-memory-record-docs.js'
import { BrowserBackend } from './browser-backend.js'

const DOC_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

function createStores() {
  const docs = new InMemoryRecordDocs()

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
            const stored = docs.openDoc()
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
