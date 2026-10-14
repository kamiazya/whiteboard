/**
 * A replica save in flight while this browser's copy is deleted, over real
 * IndexedDB and the sealed router.
 *
 * The save has read the record and sealed its delta when the copy's claim
 * and bytes go. Its append then lands on nothing: with the claim gone the
 * router answers plaintext, so an unconditional append would leave the typed
 * text in clear under an id no listing names, and the next pull of the same
 * workspace would mint a sealed snapshot over it — a copy that never opens
 * again.
 */

import { forgetAllForTests } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import type { DocRef, DocumentStore } from '@kamiazya/whiteboard-ports'
import { DocumentStoreWorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, expect, it, onTestFinished } from 'vitest'
import { clearNamedDb } from '../test-utils/browser-document.js'
import { replicaKeyFetch } from '../test-utils/replica-key-fetch.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { IdbDocumentStore } from './idb-document-store.js'
import { connectReplicaKeeper, isReplicaCopy, openDocumentStore } from './replica-store.js'
import { forgetReplicaEntry, withReplicaEntry } from './replicas.js'
import { createUserSettingsStore } from './user-settings-store.js'
import { isWorkspaceRemovedError, refuseUnlessHeld } from './workspace-tombstone.js'

const DB_NAME = 'whiteboard-replica-append-race'
const DAEMON = 'http://127.0.0.1:3099'
const WORKSPACE_ID = '01JD0REPLICAAPPENDRACE0001'
const MARKER = 'typed-while-the-copy-was-deleted'

/** Every string IndexedDB holds for the test database, bytes decoded as text. */
async function storedText(): Promise<string> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  const parts: string[] = []
  const collect = (value: unknown): void => {
    if (typeof value === 'string') parts.push(value)
    else if (ArrayBuffer.isView(value)) parts.push(new TextDecoder().decode(value as Uint8Array))
    else if (Array.isArray(value)) value.forEach(collect)
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(collect)
  }
  for (const name of Array.from(db.objectStoreNames)) {
    collect(
      await new Promise<unknown[]>((resolve, reject) => {
        const req = db.transaction([name], 'readonly').objectStore(name).getAll()
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
    )
  }
  db.close()
  return parts.join('\n')
}

/** The router, with `appendDeltas` held until `release`. */
function pausedAtAppend(inner: DocumentStore) {
  let release = (): void => {}
  let reach = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const reached = new Promise<void>((resolve) => {
    reach = resolve
  })
  const store: DocumentStore = {
    loadSnapshot: (input) => inner.loadSnapshot(input),
    readSnapshotManifest: (input) => inner.readSnapshotManifest(input),
    saveSnapshot: (input) => inner.saveSnapshot(input),
    saveCompactedSnapshot: (input) => inner.saveCompactedSnapshot(input),
    loadDeltas: (input) => inner.loadDeltas(input),
    readFrontier: (input) => inner.readFrontier(input),
    deleteDoc: (input) => inner.deleteDoc(input),
    appendDeltas: async (input) => {
      reach()
      await gate
      return inner.appendDeltas(input)
    },
  }
  return { store, reached, release }
}

function claim(): void {
  createUserSettingsStore().update((current) =>
    withReplicaEntry(current, WORKSPACE_ID, {
      daemonBaseUrl: DAEMON,
      syncedAt: new Date().toISOString(),
    }),
  )
}

beforeEach(async () => {
  await clearNamedDb(DB_NAME)
})

afterEach(async () => {
  connectReplicaKeeper(null)
  forgetAllForTests()
  await clearNamedDb(DB_NAME)
})

it('a save across Delete copy writes nothing, and the next pull opens', async () => {
  onTestFinished(() => createUserSettingsStore().reset())
  const docRef: DocRef = { kind: 'workspace-tree', workspaceId: WORKSPACE_ID }
  claim()
  connectReplicaKeeper({ baseUrl: DAEMON, fetch: replicaKeyFetch() })
  const docs = new BrowserWorkspaceDocs(DB_NAME)
  const seed = new LoroDoc()
  seed.getText('t').insert(0, 'seed ')
  await docs.save(WORKSPACE_ID, seed)
  const held = await docs.open(WORKSPACE_ID)
  if (held === null) throw new Error('expected the seeded copy')
  held.getText('t').insert(0, MARKER)

  // Another tab's page, composed as `BrowserWorkspaceDocs` composes itself.
  const paused = pausedAtAppend(openDocumentStore(DB_NAME))
  const otherTab = new DocumentStoreWorkspaceDocs(paused.store, {
    beforeMint: (id) => refuseUnlessHeld(id, isReplicaCopy(id), DB_NAME),
  })
  const saving = otherTab.save(WORKSPACE_ID, held)
  await paused.reached
  // Delete copy's steps: the claim, then the bytes.
  createUserSettingsStore().update((current) => forgetReplicaEntry(current, WORKSPACE_ID))
  await openDocumentStore(DB_NAME).deleteDoc({ docRef })
  paused.release()

  await expect(saving).rejects.toSatisfy(isWorkspaceRemovedError)
  const left = await new IdbDocumentStore(DB_NAME).loadDeltas({ docRef, afterSeq: null })
  expect(left.updates).toEqual([])
  expect(await storedText()).not.toContain(MARKER)

  claim()
  const pulled = new LoroDoc()
  pulled.getText('t').insert(0, 'pulled again')
  await docs.save(WORKSPACE_ID, pulled)
  expect((await docs.open(WORKSPACE_ID))?.getText('t').toString()).toBe('pulled again')
})
