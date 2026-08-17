/**
 * The browser-local implementation against the shared CanvasBackend contract.
 * Its transport siblings run the same cases from mcp-server, where they live.
 *
 * In-memory stores rather than real IndexedDB: the contract is about what a
 * caller of the port may rely on, and the persistence layer has its own
 * browser-mode suite (`browser-local-backend.browser.test.tsx`).
 */
import type { CanvasBackendHarness } from '@kamiazya/whiteboard-mcp/canvas-backend-contract-suite'
import { canvasBackendContract } from '@kamiazya/whiteboard-mcp/canvas-backend-contract-suite'
import { describe } from 'vitest'
import { BrowserLocalBackend } from './browser-local-backend.js'
import type { DocumentFileStore } from './document-file-store.js'
import type { LoroStore } from './loro-store.js'

function createStores(written: Uint8Array[]) {
  let snapshot: Uint8Array | null = null
  const deltas: Uint8Array[] = []

  const store = {
    load: async (_canvasId: string) =>
      snapshot === null
        ? ({ kind: 'not-found' } as const)
        : ({ kind: 'ok', snapshot, deltas } as const),
    save: async (_canvasId: string, bytes: Uint8Array) => {
      snapshot = bytes
      written.push(bytes)
    },
    appendDelta: async (_canvasId: string, bytes: Uint8Array) => {
      deltas.push(bytes)
      written.push(bytes)
    },
  } as unknown as LoroStore

  const files = new Map<string, { mimeType: string; blob: Blob }>()
  const fileStore = {
    get: async (fileId: string) => files.get(fileId)?.blob ?? null,
    put: async (fileId: string, record: { mimeType: string; blob: Blob }) => {
      files.set(fileId, record)
    },
  } as unknown as DocumentFileStore

  return { store, fileStore }
}

describe('CanvasBackend contract: BrowserLocalBackend', () => {
  canvasBackendContract((): CanvasBackendHarness => {
    const written: Uint8Array[] = []
    const { store, fileStore } = createStores(written)
    const backend = new BrowserLocalBackend('canvas-a', store, fileStore)
    return { backend, sentUpdates: () => written, cleanup: () => backend.disconnect() }
  })
})
