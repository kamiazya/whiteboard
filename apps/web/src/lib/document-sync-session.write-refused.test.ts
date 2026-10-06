/**
 * What a session does after its keeper refuses a write for what the bytes
 * would do. The refused ops never land, and every later edit is built on
 * them, so a session that carried on from its own copy saved nothing more —
 * while the page read "saved" and a reload lost all of it. Through the real
 * browser keeper, which refuses a markdown body past its limit.
 */
import type {
  DocumentBackend,
  DocumentBackendHandlers,
  SyncWriteRefusal,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readMarkdownBody,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { MARKDOWN_MAX_CHARS } from '@kamiazya/whiteboard-model'
import type { WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { BrowserBackend } from './browser-backend.js'
import type { BrowserPersistenceState } from './browser-persistence-state.js'
import {
  createDocumentSyncSession,
  createGenerationCounters,
  type DocumentSyncSession,
} from './document-sync-session.js'
import type { LoroStore } from './loro-store.js'

// jsdom has no IndexedDB, so the startup fold and the timestamp touch are
// replaced by their outcome; see browser-backend.read-failure.test.ts.
vi.mock('./fold-workspace.js', () => ({
  foldOrServeTheTree: async () => ({ folded: 0, skipped: 0 }),
}))
vi.mock('./loro-store.js', () => ({ LoroStore: class {}, touchContentTimestamp: async () => {} }))

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

function markdownRecord(body: string): LoroDoc {
  const record = new LoroDoc()
  createWorkspaceDocumentAtPath(record, { path: 'notes', documentId: ID, kind: 'markdown' })
  writeMarkdownBody(documentContainers(record, ID), body)
  return record
}

function openOnBrowserKeeper(body: string) {
  const record = markdownRecord(body)
  const stored = () => readMarkdownBody(documentContainers(record, ID))
  const docs = {
    create: async () => record,
    save: async () => null,
  } as unknown as WorkspaceDocs
  const backend = new BrowserBackend({ documentId: ID, path: 'notes', kind: 'markdown' }, docs, {
    load: async () => ({ kind: 'missing' }),
  } as unknown as LoroStore)

  const refusals: SyncWriteRefusal[] = []
  const persistence: BrowserPersistenceState['kind'][] = []
  // Each time the session says saved, whether what it shows is what is kept.
  const savedOverWhatIsKept: boolean[] = []
  let session: DocumentSyncSession | null = null
  session = createDocumentSyncSession(backend, {
    getOptions: () => ({}),
    onStatusChange: () => {},
    onBackendError: () => {},
    onRestoreChange: () => {},
    dispatchIdentityEvent: () => {},
    generations: createGenerationCounters(),
    contentDocumentId: ID,
    onPersistenceChange: (state) => {
      persistence.push(state.kind)
      if (state.kind === 'saved') savedOverWhatIsKept.push(session?.getMarkdownBody() === stored())
    },
    onWriteRefused: (refusal) => refusals.push(refusal),
  })
  session.connect()
  const typed = (edit: (text: ReturnType<LoroDoc['getText']>) => void) => {
    const binding = session?.getBodyBinding()
    const text = binding?.readText(binding.doc)
    if (!binding || !text) throw new Error('no body binding yet')
    edit(text)
    binding.commit()
  }
  return { session, stored, typed, refusals, persistence, savedOverWhatIsKept }
}

describe('a session whose browser keeper refuses a write', () => {
  it('takes what the keeper holds, says why, and saves the edits made afterwards', async () => {
    const s = openOnBrowserKeeper('hello')
    await vi.waitFor(() => expect(s.session.getMarkdownBody()).toBe('hello'))

    s.typed((text) => text.insert(0, 'x'.repeat(MARKDOWN_MAX_CHARS + 1)))
    await expectLoggedFailure('refused an update past a text limit')
    await vi.waitFor(() => expect(s.refusals.map((r) => r.code)).toEqual(['markdown_too_large']))
    // The refused text is gone from the page, not kept as if it were saved.
    await vi.waitFor(() => expect(s.session.getMarkdownBody()).toBe('hello'))

    s.typed((text) => text.insert(5, '!'))
    await vi.waitFor(() => expect(s.stored()).toBe('hello!'))
    await vi.waitFor(() => expect(s.persistence.at(-1)).toBe('saved'))

    expect(s.session.getMarkdownBody()).toBe('hello!')
    expect(s.savedOverWhatIsKept).not.toContain(false)
    s.session.dispose()
  })
})

describe('a session whose keeper answers a refusal from across a round trip', () => {
  // The daemon's state arrives a fetch after the refusal does. Until it has
  // replaced the copy holding the refused ops, nothing on screen is saved —
  // and a write failure that was being retried is not one any more, since
  // what it was retrying has been dropped.
  it('reads saved only once the keeper state has replaced its copy', async () => {
    let handlers: DocumentBackendHandlers | null = null
    let held: () => void = () => {}
    let pushed = false
    const backend = {
      connect: (h: DocumentBackendHandlers) => {
        handlers = h
        h.onConnected()
      },
      disconnect: () => {},
      // A push the keeper refuses is answered by the refusal and then
      // resolves, the way a backend that recovers on its own answers it.
      pushLocalUpdate: () =>
        new Promise<void>((resolve) => {
          held = resolve
          pushed = true
        }),
      sendClientReady: () => {},
    } satisfies DocumentBackend
    const persistence: BrowserPersistenceState[] = []
    const session = createDocumentSyncSession(backend, {
      getOptions: () => ({}),
      onStatusChange: () => {},
      onBackendError: () => {},
      onRestoreChange: () => {},
      dispatchIdentityEvent: () => {},
      generations: createGenerationCounters(),
      contentDocumentId: ID,
      onPersistenceChange: (state) => persistence.push(state),
    })
    session.connect()
    const keeper = () => handlers as unknown as DocumentBackendHandlers
    keeper().onSnapshot(markdownRecord('kept').export({ mode: 'snapshot' }))
    const type = (text: string) => {
      const binding = session.getBodyBinding()
      binding?.readText(binding.doc)?.insert(0, text)
      binding?.commit()
    }
    type('refused ')
    await vi.waitFor(() => expect(pushed).toBe(true))
    // Reported as a failure being retried first, as a worker reports it.
    keeper().onError?.('storage-failure')
    expect(persistence.at(-1)?.kind).toBe('degraded')
    keeper().onWriteRefused?.({ code: 'markdown_too_large', message: 'too long' })
    expect(persistence.at(-1)?.kind).toBe('pending')
    held()
    for (let turn = 0; turn < 30; turn++) await Promise.resolve()
    expect(persistence.at(-1)?.kind).toBe('pending')

    keeper().onSnapshot(markdownRecord('kept').export({ mode: 'snapshot' }))
    await vi.waitFor(() => expect(persistence.at(-1)?.kind).toBe('saved'))
    expect(session.getMarkdownBody()).toBe('kept')
    session.dispose()
  })
})
