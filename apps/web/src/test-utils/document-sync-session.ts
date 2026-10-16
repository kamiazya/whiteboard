/**
 * A document sync session over a fake keeper, for the session's own tests.
 *
 * The fake is held to `DocumentBackend` with `satisfies`, so a member the
 * contract gains or renames fails the compile here, once, instead of
 * surfacing as a TypeError inside whichever behaviour test calls it first.
 */
import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import type { BrowserPersistenceState } from '../lib/browser-persistence-state.js'
import {
  createDocumentSyncSession,
  createGenerationCounters,
  type SessionDeps,
} from '../lib/document-sync-session.js'
import type { SyncStatus } from '../lib/document-sync-types.js'

export function snapshotOf(value: SpatialCanvas): Uint8Array {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, value)
  return doc.export({ mode: 'snapshot' })
}

/** Enough turns for a push's settlement to reach the session's persistence report. */
export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

interface TestSessionOptions {
  /** The keeper's push; resolves at once unless given. */
  readonly push?: DocumentBackend['pushLocalUpdate']
  /** Whether connecting reports the stream open at once. Defaults to true. */
  readonly connected?: boolean
  /** Delivered as the first snapshot after connecting; without one the session holds no document. */
  readonly snapshot?: Uint8Array
  /** Overrides for the session's dependencies, over recorders and no-ops. */
  readonly deps?: Partial<SessionDeps>
}

export function openTestSession(options: TestSessionOptions = {}) {
  let handlers: DocumentBackendHandlers | null = null
  const backend = {
    connect(h: DocumentBackendHandlers) {
      handlers = h
      if (options.connected !== false) h.onConnected()
    },
    disconnect() {},
    pushLocalUpdate: options.push ?? (() => Promise.resolve()),
    sendClientReady() {},
  } satisfies DocumentBackend
  const statuses: SyncStatus[] = []
  const persistenceStates: BrowserPersistenceState[] = []
  const persistence: BrowserPersistenceState['kind'][] = []
  const session = createDocumentSyncSession(backend, {
    getOptions: () => ({}),
    onStatusChange: (status) => statuses.push(status),
    onBackendError: () => {},
    onRestoreChange: () => {},
    dispatchIdentityEvent: () => {},
    generations: createGenerationCounters(),
    onPersistenceChange: (state) => {
      persistenceStates.push(state)
      persistence.push(state.kind)
    },
    ...options.deps,
  })
  const keeper = (): DocumentBackendHandlers => {
    if (handlers === null) throw new Error('the session has not connected to the fake keeper')
    return handlers
  }
  session.connect()
  if (options.snapshot !== undefined) keeper().onSnapshot(options.snapshot)
  return { session, handlers: keeper, statuses, persistence, persistenceStates }
}
