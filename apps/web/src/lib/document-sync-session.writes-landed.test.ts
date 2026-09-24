/**
 * A worker-backed transport retries a refused write on its own and says when
 * it lands. The person may have stopped typing, so no later write of this
 * session's will come to clear the failure — the landing has to.
 */
import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPersistenceState } from './browser-persistence-state.js'
import { createDocumentSyncSession, createGenerationCounters } from './document-sync-session.js'
import { applyCommand, type EditorCommand } from './spatial/commands.js'

const canvas: SpatialCanvas = {
  nodes: [textNode({ id: 'n-a', x: 0, y: 0, width: 100, height: 40, text: 'A' })],
  edges: [],
}

function snapshotOf(value: SpatialCanvas): Uint8Array {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, value)
  return doc.export({ mode: 'snapshot' })
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('a write the backend retries on its own', () => {
  it('leaves the document saved, not degraded, once the backend says it landed', async () => {
    vi.useFakeTimers()
    let handlers: DocumentBackendHandlers | null = null
    let releasePush: () => void = () => {}
    const backend = {
      connect(h: DocumentBackendHandlers) {
        handlers = h
        h.onConnected()
      },
      disconnect() {},
      pushLocalUpdate: () =>
        new Promise<void>((resolve) => {
          releasePush = resolve
        }),
      getFile: async () => null,
      putFile: async () => {},
      sendClientReady() {},
      sendExportResponse() {},
    } as unknown as DocumentBackend
    const persistence: BrowserPersistenceState['kind'][] = []
    const statuses: string[] = []
    const session = createDocumentSyncSession(backend, {
      getOptions: () => ({}),
      onStatusChange: (status) => statuses.push(status),
      onBackendError: () => {},
      onRestoreChange: () => {},
      dispatchIdentityEvent: () => {},
      generations: createGenerationCounters(),
      onPersistenceChange: (state) => persistence.push(state.kind),
    })
    session.connect()
    handlers!.onSnapshot(snapshotOf(canvas))
    const edit: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }
    session.onChange(applyCommand(canvas, edit), edit)
    await vi.advanceTimersByTimeAsync(300)
    await flushMicrotasks()
    // The order a worker-backed push produces: the push is handed over, the
    // write is refused and REPORTED, then the push resolves as if nothing
    // happened — which must not read as saved.
    handlers!.onError?.('storage-failure')
    releasePush()
    await flushMicrotasks()
    expect(persistence).toEqual(['pending', 'degraded'])

    handlers!.onWritesLanded?.()
    await flushMicrotasks()
    expect(persistence).toEqual(['pending', 'degraded', 'saved'])
    expect(statuses.at(-1)).toBe('connected')
    session.dispose()
  })
})
