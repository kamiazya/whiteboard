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

function openSession() {
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
  return {
    session,
    persistence,
    statuses,
    handlers: () => handlers!,
    releasePush: () => releasePush(),
  }
}

async function editAndPush(session: ReturnType<typeof openSession>['session']) {
  const edit: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }
  session.onChange(applyCommand(canvas, edit), edit)
  await vi.advanceTimersByTimeAsync(300)
  await flushMicrotasks()
}

describe('a write the backend retries on its own', () => {
  it('leaves the document saved, not degraded, once the backend says it landed', async () => {
    vi.useFakeTimers()
    const s = openSession()
    await editAndPush(s.session)
    // The order a push can produce: handed over, refused and REPORTED, then
    // resolved as if nothing happened — which must not read as saved.
    s.handlers().onError?.('storage-failure')
    s.releasePush()
    await flushMicrotasks()
    expect(s.persistence).toEqual(['pending', 'degraded'])

    s.handlers().onWritesLanded?.()
    await flushMicrotasks()
    expect(s.persistence).toEqual(['pending', 'degraded', 'saved'])
    expect(s.statuses.at(-1)).toBe('connected')
    s.session.dispose()
  })

  // A worker-backed push resolves when it is handed over, so the session has
  // already settled by the time the keeper refuses — the refusal is still a
  // write that did not land, and has to say so.
  it('degrades on a refusal that arrives after the push already resolved', async () => {
    vi.useFakeTimers()
    const s = openSession()
    await editAndPush(s.session)
    s.releasePush()
    await flushMicrotasks()
    expect(s.persistence).toEqual(['pending', 'saved'])

    s.handlers().onError?.('storage-failure')
    await flushMicrotasks()
    expect(s.persistence).toEqual(['pending', 'saved', 'degraded'])
    s.handlers().onWritesLanded?.()
    await flushMicrotasks()
    expect(s.persistence).toEqual(['pending', 'saved', 'degraded', 'saved'])
    s.session.dispose()
  })

  // The same report also names a failed LOAD, which the page shows on its own
  // screen; before anything was written it is not a persistence fact.
  it('says nothing of persistence for a failure before any write', async () => {
    vi.useFakeTimers()
    const s = openSession()
    s.handlers().onError?.('storage-failure')
    await flushMicrotasks()
    expect(s.persistence).toEqual([])
    s.session.dispose()
  })
})
