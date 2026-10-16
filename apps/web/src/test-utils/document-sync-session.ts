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
import { vi } from 'vitest'
import type { BrowserPersistenceState } from '../lib/browser-persistence-state.js'
import {
  COMMIT_DEBOUNCE_MS,
  createDocumentSyncSession,
  createGenerationCounters,
  type DocumentSyncSession,
  type SessionDeps,
} from '../lib/document-sync-session.js'
import type { SyncStatus } from '../lib/document-sync-types.js'
import { applyCommand, type EditorCommand } from '../lib/spatial/commands.js'

export function snapshotOf(value: SpatialCanvas): Uint8Array {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, value)
  return doc.export({ mode: 'snapshot' })
}

/** Enough turns for a push's settlement to reach the session's persistence report. */
export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

/**
 * Makes one edit over `from`, then lets the commit debounce fire and the push
 * it starts settle. Advancing by the session's own constant keeps a change to
 * the debounce from reading as a missing push in every test that edits.
 * Needs fake timers.
 */
export async function editAndPush(
  session: DocumentSyncSession,
  from: SpatialCanvas,
  edit: EditorCommand,
): Promise<void> {
  session.onChange(applyCommand(from, edit), edit)
  await vi.advanceTimersByTimeAsync(COMMIT_DEBOUNCE_MS)
  await flushMicrotasks()
}

/**
 * Holds the handlers a fake keeper is connected with and hands them back
 * typed, so a test reads them without casting a closure-assigned `let`.
 */
export function heldHandlers() {
  let held: DocumentBackendHandlers | null = null
  return {
    hold(h: DocumentBackendHandlers): void {
      held = h
    },
    handlers(): DocumentBackendHandlers {
      if (held === null) throw new Error('the session has not connected to the fake keeper')
      return held
    },
  }
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
  const { hold, handlers: keeper } = heldHandlers()
  const backend = {
    connect(h: DocumentBackendHandlers) {
      hold(h)
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
  session.connect()
  if (options.snapshot !== undefined) keeper().onSnapshot(options.snapshot)
  return { session, handlers: keeper, statuses, persistence, persistenceStates }
}
