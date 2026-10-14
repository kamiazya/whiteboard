/**
 * A forgotten replica copy stays forgotten, over fake-indexeddb: what a page
 * still holding the record in another tab can write afterwards, and what it
 * is told. Which ids may mint a record at all is pinned here too, since the
 * forget is the case that made the rule necessary.
 */

// jsdom + fake-indexeddb: this is IndexedDB persistence logic, not browser layout.
import 'fake-indexeddb/auto'
import { forgetAllForTests } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearWhiteboardDb, registerTestWorkspace } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { replicaKeyFetch } from '../test-utils/replica-key-fetch.js'
import { whiteboardDbName } from './browser-idb.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { forgetReplicaCopy } from './browser-workspace-removal.js'
import { connectReplicaKeeper, markReplica } from './replica-store.js'
import { withReplicaEntry } from './replicas.js'
import { createUserSettingsStore } from './user-settings-store.js'
import { listenToWorkspace, type WorkspaceBroadcast } from './workspace-broadcast.js'
import { isWorkspaceRemovedError } from './workspace-tombstone.js'

claimIsolatedWhiteboardDb('browserworkspaceremovalreplica')

const DAEMON = 'http://127.0.0.1:3098'
const MARKER = 'a-forgotten-replica-marker-nobody-should-see'

let counter = 0
// `markReplica`'s mark is module state, so each test mints its own id.
function freshWorkspaceId(): string {
  counter += 1
  return `forgetreplica${counter}`
}

function recordWith(text: string): LoroDoc {
  const doc = new LoroDoc()
  doc.getText('t').insert(0, text)
  doc.commit()
  return doc
}

/** Every string and byte run held by any object store, decoded as text. */
async function storedText(): Promise<string> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(whiteboardDbName())
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  const parts: string[] = []
  const visit = (value: unknown): void => {
    if (typeof value === 'string') parts.push(value)
    else if (ArrayBuffer.isView(value)) parts.push(new TextDecoder().decode(value as Uint8Array))
    else if (Array.isArray(value)) value.forEach(visit)
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(visit)
  }
  try {
    for (const name of Array.from(db.objectStoreNames)) {
      const records = await new Promise<unknown[]>((resolve, reject) => {
        const req = db.transaction([name], 'readonly').objectStore(name).getAll()
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      visit(records)
    }
  } finally {
    db.close()
  }
  return parts.join('\n')
}

/** A replica claimed in Settings and stored sealed, as a pull leaves it. */
async function storedReplica(workspaceId: string): Promise<void> {
  createUserSettingsStore().update((current) =>
    withReplicaEntry(current, workspaceId, { daemonBaseUrl: DAEMON, syncedAt: '2026-10-01' }),
  )
  await new BrowserWorkspaceDocs().save(workspaceId, recordWith(`${MARKER}-pulled`))
}

describe('forgetReplicaCopy against a page still holding the copy', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    localStorage.clear()
    connectReplicaKeeper({ baseUrl: DAEMON, fetch: replicaKeyFetch() })
  })
  afterEach(() => {
    connectReplicaKeeper(null)
    forgetAllForTests()
  })

  it('refuses the stale save rather than writing the copy back', async () => {
    const workspaceId = freshWorkspaceId()
    await storedReplica(workspaceId)

    await forgetReplicaCopy(createUserSettingsStore(), workspaceId, DAEMON)
    const save = new BrowserWorkspaceDocs().save(workspaceId, recordWith(`${MARKER}-stale`))

    await expect(save).rejects.toSatisfy(isWorkspaceRemovedError)
    expect(await new BrowserWorkspaceDocs().open(workspaceId)).toBeNull()
    expect(await storedText()).not.toContain(MARKER)
  })

  it('refuses it in the tab that pulled the copy, too', async () => {
    const workspaceId = freshWorkspaceId()
    markReplica(workspaceId, DAEMON)
    await storedReplica(workspaceId)

    await forgetReplicaCopy(createUserSettingsStore(), workspaceId, DAEMON)
    const save = new BrowserWorkspaceDocs().save(workspaceId, recordWith(`${MARKER}-stale`))

    await expect(save).rejects.toSatisfy(isWorkspaceRemovedError)
    expect(await new BrowserWorkspaceDocs().open(workspaceId)).toBeNull()
  })

  it('tells every page holding the copy that it is gone', async () => {
    const workspaceId = freshWorkspaceId()
    await storedReplica(workspaceId)
    const heard: WorkspaceBroadcast[] = []
    const end = listenToWorkspace(workspaceId, (message) => heard.push(message))
    try {
      await forgetReplicaCopy(createUserSettingsStore(), workspaceId, DAEMON)
      await expect.poll(() => heard).toContainEqual({ type: 'workspace-removed' })
    } finally {
      end.close()
    }
  })
})

describe('which ids may mint a workspace record', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    localStorage.clear()
    connectReplicaKeeper({ baseUrl: DAEMON, fetch: replicaKeyFetch() })
  })
  afterEach(() => {
    connectReplicaKeeper(null)
    forgetAllForTests()
  })

  it('refuses an id that is neither kept here nor a replica', async () => {
    const workspaceId = freshWorkspaceId()
    await expect(new BrowserWorkspaceDocs().create(workspaceId)).rejects.toSatisfy(
      isWorkspaceRemovedError,
    )
    expect(await new BrowserWorkspaceDocs().open(workspaceId)).toBeNull()
  })

  it('admits a workspace this browser keeps', async () => {
    const workspaceId = freshWorkspaceId()
    await registerTestWorkspace({ workspaceId })
    await new BrowserWorkspaceDocs().create(workspaceId)
    expect(await new BrowserWorkspaceDocs().open(workspaceId)).not.toBeNull()
  })

  it('admits a first pull, marked before its claim is registered', async () => {
    const workspaceId = freshWorkspaceId()
    markReplica(workspaceId, DAEMON)
    await new BrowserWorkspaceDocs().save(workspaceId, recordWith(`${MARKER}-first`))
    expect(await new BrowserWorkspaceDocs().open(workspaceId)).not.toBeNull()
    expect(await storedText()).not.toContain(MARKER)
  })
})
