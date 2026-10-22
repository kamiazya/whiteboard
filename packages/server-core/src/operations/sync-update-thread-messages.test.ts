/**
 * The per-thread message ceiling on both sync paths, which carry Loro bytes
 * no tool op reads: a reply that takes a thread past `THREAD_MAX_MESSAGES` is
 * refused 413 with nothing kept, and the reply that brings it to the bound is
 * taken.
 */
import {
  createWorkspaceDocumentAtPath,
  type DocumentContainers,
  documentContainers,
  readAnnotations,
  writeCommentThread,
  writeThreadMessage,
} from '@kamiazya/whiteboard-loro-adapter'
import { THREAD_MAX_MESSAGES } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { LiveDocuments, WorkspaceDocuments } from '../server-deps.js'
import { StoredDoc } from '../test-utils/stored-doc.js'
import { unusedBlobStore } from '../test-utils/unused-blob-store.js'
import { unusedLiveDocuments } from '../test-utils/unused-live-documents.js'
import { unusedWorkspaceDocuments } from '../test-utils/unused-workspace-documents.js'
import { applyDocumentUpdate } from './apply-document-update.js'
import { applyWorkspaceDocumentUpdate } from './apply-workspace-document-update.js'
import { syncWriteAnswer } from './sync-write-refusals.js'

const WS = 'ws-1'
const NOTE = '01BRWAAAAAAAAAAAAAAAAAAAB0'

function seedThread(doc: DocumentContainers, messages: number): void {
  writeCommentThread(doc, {
    id: 't1',
    anchor: { kind: 'document' },
    status: 'open',
    messages: Array.from({ length: messages }, (_, m) => ({ id: `m${m}`, body: 'and?' })),
  })
}

function updateFrom(base: LoroDoc, edit: (client: LoroDoc) => void): Uint8Array {
  const client = base.fork()
  const from = client.oplogVersion()
  edit(client)
  client.commit()
  return client.export({ mode: 'update', from })
}

const reply = (doc: DocumentContainers) =>
  writeThreadMessage(doc, 't1', { id: 'extra', body: 'one more' })

/** The two sync paths, each over a store seeded with one thread of `messages`. */
const PATHS = {
  'the per-document path': (messages: number) => {
    const doc = new LoroDoc()
    seedThread(doc, messages)
    const store = new StoredDoc(doc)
    const liveDocuments: LiveDocuments = {
      ...unusedLiveDocuments(),
      withWriteLock: (_workspaceId, fn) => fn(),
      get: async () => store.get(),
      kind: async () => 'markdown',
      save: async (_workspaceId, _path, saved) => store.save(saved),
      evict: () => store.evict(),
    }
    return {
      store,
      held: (): DocumentContainers => store.get(),
      send: (edit: (doc: DocumentContainers) => void) =>
        applyDocumentUpdate(
          { liveDocuments },
          { workspaceId: WS, path: 'note', update: updateFrom(store.get(), edit) },
        ),
    }
  },
  'the workspace-document path': (messages: number) => {
    const doc = new LoroDoc()
    createWorkspaceDocumentAtPath(doc, { path: 'note', documentId: NOTE, kind: 'markdown' })
    seedThread(documentContainers(doc, NOTE), messages)
    const store = new StoredDoc(doc)
    const workspaceDocuments: WorkspaceDocuments = {
      ...unusedWorkspaceDocuments(),
      get: async () => store.get(),
      save: async (_workspaceId, saved) => store.save(saved),
      evict: () => store.evict(),
      evictProjections: () => {},
    }
    const liveDocuments: LiveDocuments = {
      ...unusedLiveDocuments(),
      withWriteLock: (_workspaceId, fn) => fn(),
    }
    return {
      store,
      held: () => documentContainers(store.get(), NOTE),
      send: (edit: (doc: DocumentContainers) => void) =>
        applyWorkspaceDocumentUpdate(
          { liveDocuments, workspaceDocuments, blobStore: unusedBlobStore() },
          {
            workspaceId: WS,
            update: updateFrom(store.get(), (client) => edit(documentContainers(client, NOTE))),
            mayPlaceDocuments: false,
          },
        ),
    }
  },
} as const

describe.each(Object.keys(PATHS) as (keyof typeof PATHS)[])('a reply sent on %s', (path) => {
  it('is taken when it brings the thread to the ceiling', async () => {
    const keeper = PATHS[path](THREAD_MAX_MESSAGES - 1)
    await keeper.send(reply)
    expect(readAnnotations(keeper.held())[0]?.messages).toHaveLength(THREAD_MAX_MESSAGES)
  })

  it('is refused one past the ceiling, 413, and nothing is kept', async () => {
    const keeper = PATHS[path](THREAD_MAX_MESSAGES)
    const refusal = await keeper.send(reply).catch((err: unknown) => err)
    expect(syncWriteAnswer(refusal)).toEqual({ code: 'too_many_thread_messages', status: 413 })
    expect(keeper.store.saves).toBe(0)
    expect(readAnnotations(keeper.held())[0]?.messages).toHaveLength(THREAD_MAX_MESSAGES)
  })
})
