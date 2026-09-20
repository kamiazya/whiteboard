/**
 * `replica-store.ts`'s factory over real IndexedDB: routing, the store-dump
 * guard (no key or plaintext bytes ever land in storage), withholding, and
 * the first-pull ordering `markReplica` exists to protect.
 */
import { forgetAll } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import type { DocRef } from '@kamiazya/whiteboard-ports'
import { chunkSnapshot, StoredDocumentUnreadableError } from '@kamiazya/whiteboard-ports'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearNamedDb } from '../test-utils/browser-document.js'
import { disconnectFromDaemon } from './disconnect-daemon.js'
import {
  connectReplicaKeeper,
  forgetDaemonKeys,
  markReplica,
  openDocumentStore,
} from './replica-store.js'
import { ReplicaKeyWithheldError } from './sealed-document-store.js'
import { createUserSettingsStore } from './user-settings-store.js'

const DB_NAME = 'whiteboard-replica-store'
const DAEMON = 'http://127.0.0.1:3099'

// A distinct workspace id per test: `markReplica`'s in-memory mark is module
// state with no test-seam reset (it never needs one in production — a tab
// only ever ADDS marks), so a shared id would leak one test's mark into the
// next regardless of file order.
let workspaceCounter = 0
function freshWorkspaceId(): string {
  workspaceCounter += 1
  return `01JD0REPLICASTORE${String(workspaceCounter).padStart(8, '0')}`
}

const WORKSPACE_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const WORKSPACE_SALT = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i)

function b64u(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

/** A daemon fetch double answering /replica-key with a fixed offline key. */
function offlineKeyFetch(): typeof fetch {
  return (async (input: Request | string | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.endsWith('/replica-key')) {
      return jsonResponse({
        workspaceKey: b64u(WORKSPACE_KEY),
        workspaceKeySalt: b64u(WORKSPACE_SALT),
        tier: 'offline',
      })
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch
}

function refusalFetch(reason: string): typeof fetch {
  return (async () => jsonResponse({ error: reason }, 403)) as typeof fetch
}

async function getAllRaw(dbName: string): Promise<{ store: string; records: unknown[] }[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(dbName)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  const out: { store: string; records: unknown[] }[] = []
  for (const storeName of Array.from(db.objectStoreNames)) {
    const records = await new Promise<unknown[]>((resolve, reject) => {
      const req = db.transaction([storeName], 'readonly').objectStore(storeName).getAll()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    out.push({ store: storeName, records })
  }
  db.close()
  return out
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (ArrayBuffer.isView(value)) out.push(new TextDecoder().decode(value as Uint8Array))
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out)
  else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, out)
  }
  return out
}

describe('replica-store', () => {
  const marker = 'a-plaintext-marker-nobody-should-see-sealed'

  beforeEach(async () => {
    await clearNamedDb(DB_NAME)
  })

  afterEach(async () => {
    connectReplicaKeeper(null)
    forgetAll()
    await clearNamedDb(DB_NAME)
  })

  it('routes an unregistered workspace-tree ref to plaintext, byte-identical to a bare write', async () => {
    const docRef: DocRef = { kind: 'workspace-tree', workspaceId: freshWorkspaceId() }
    const store = openDocumentStore(DB_NAME)
    const { manifest, chunks } = chunkSnapshot(new TextEncoder().encode(marker), 200)
    await store.saveSnapshot({ docRef, manifest, chunks, frontier: new Uint8Array(4) })

    const loaded = await store.loadSnapshot({ docRef })
    expect(loaded?.chunks.map((c) => new TextDecoder().decode(c.bytes))).toEqual([marker])

    // Written straight, no envelope: the marker string is directly present.
    const dump = await getAllRaw(DB_NAME)
    const found = dump.flatMap((s) => collectStrings(s.records)).some((s) => s.includes(marker))
    expect(found).toBe(true)
  })

  it('markReplica seals the FIRST pull even before the registry entry exists', async () => {
    const workspaceId = freshWorkspaceId()
    const docRef: DocRef = { kind: 'workspace-tree', workspaceId }
    connectReplicaKeeper({ baseUrl: DAEMON, token: 'tok', fetch: offlineKeyFetch() })
    markReplica(workspaceId, DAEMON)

    const store = openDocumentStore(DB_NAME)
    const { manifest, chunks } = chunkSnapshot(new TextEncoder().encode(marker), 200)
    await store.saveSnapshot({ docRef, manifest, chunks, frontier: new Uint8Array(4) })

    const dump = await getAllRaw(DB_NAME)
    const found = dump.flatMap((s) => collectStrings(s.records)).some((s) => s.includes(marker))
    expect(found).toBe(false)

    // Sealed under the held key, so the same factory reads it straight back.
    const loaded = await store.loadSnapshot({ docRef })
    expect(loaded?.chunks.map((c) => new TextDecoder().decode(c.bytes))).toEqual([marker])
  })

  it('store-dump guard: no raw key bytes or their base64url text land in storage', async () => {
    const workspaceId = freshWorkspaceId()
    const docRef: DocRef = { kind: 'workspace-tree', workspaceId }
    connectReplicaKeeper({ baseUrl: DAEMON, token: 'tok', fetch: offlineKeyFetch() })
    markReplica(workspaceId, DAEMON)
    const store = openDocumentStore(DB_NAME)
    const { manifest, chunks } = chunkSnapshot(new TextEncoder().encode(marker), 200)
    await store.saveSnapshot({ docRef, manifest, chunks, frontier: new Uint8Array(4) })

    const rawKeyText = b64u(WORKSPACE_KEY)
    const dump = await getAllRaw(DB_NAME)
    const idbStrings = dump.flatMap((s) => collectStrings(s.records))
    for (const s of idbStrings) {
      expect(s.includes(marker)).toBe(false)
      expect(s.includes(rawKeyText)).toBe(false)
    }
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i) as string
      const value = localStorage.getItem(key) ?? ''
      expect(value.includes(rawKeyText)).toBe(false)
      expect(value.includes(marker)).toBe(false)
    }
  })

  it('withholds (not_a_member): save rejects and nothing is written', async () => {
    const workspaceId = freshWorkspaceId()
    const docRef: DocRef = { kind: 'workspace-tree', workspaceId }
    connectReplicaKeeper({ baseUrl: DAEMON, token: 'tok', fetch: refusalFetch('not_a_member') })
    markReplica(workspaceId, DAEMON)
    const store = openDocumentStore(DB_NAME)
    const { manifest, chunks } = chunkSnapshot(new TextEncoder().encode(marker), 200)
    await expect(
      store.saveSnapshot({ docRef, manifest, chunks, frontier: new Uint8Array(4) }),
    ).rejects.toBeInstanceOf(ReplicaKeyWithheldError)

    const dump = await getAllRaw(DB_NAME)
    for (const { records } of dump) expect(records.length).toBe(0)
  })

  it('a disconnect withholds a previously-held key instead of continuing to answer it', async () => {
    const workspaceId = freshWorkspaceId()
    const docRef: DocRef = { kind: 'workspace-tree', workspaceId }
    connectReplicaKeeper({ baseUrl: DAEMON, token: 'tok', fetch: offlineKeyFetch() })
    markReplica(workspaceId, DAEMON)
    const store = openDocumentStore(DB_NAME)
    const { manifest, chunks } = chunkSnapshot(new TextEncoder().encode(marker), 200)
    await store.saveSnapshot({ docRef, manifest, chunks, frontier: new Uint8Array(4) })
    // Held: reads back without another fetch.
    const loaded = await store.loadSnapshot({ docRef })
    expect(loaded).not.toBeNull()

    // Disconnect drops the held key for this daemon.
    connectReplicaKeeper(null)
    await expect(store.loadSnapshot({ docRef })).rejects.toBeInstanceOf(ReplicaKeyWithheldError)

    // Explicit forget is idempotent and safe to call again.
    forgetDaemonKeys(DAEMON)
  })

  it('Settings disconnect drops the connection at once: a load before App re-renders mints nothing', async () => {
    // `disconnectFromDaemon` runs synchronously in a click handler; App's
    // `connectReplicaKeeper(null)` follows on the next render. In between,
    // a load must find no connection — otherwise the old session mints a
    // replacement for the key that was just forgotten.
    const workspaceId = freshWorkspaceId()
    const docRef: DocRef = { kind: 'workspace-tree', workspaceId }
    let keyCalls = 0
    const countingFetch: typeof fetch = (async (input: Request | string | URL) => {
      keyCalls += 1
      return offlineKeyFetch()(input)
    }) as typeof fetch
    connectReplicaKeeper({ baseUrl: DAEMON, token: 'tok', fetch: countingFetch })
    markReplica(workspaceId, DAEMON)
    const store = openDocumentStore(DB_NAME)
    const { manifest, chunks } = chunkSnapshot(new TextEncoder().encode(marker), 200)
    await store.saveSnapshot({ docRef, manifest, chunks, frontier: new Uint8Array(4) })
    expect(keyCalls).toBe(1)

    disconnectFromDaemon(createUserSettingsStore(), DAEMON)
    await expect(store.loadSnapshot({ docRef })).rejects.toBeInstanceOf(ReplicaKeyWithheldError)
    expect(keyCalls).toBe(1)
    localStorage.clear()
  })

  it('a reconnect to the same daemon with a different token forgets the previous key rather than continuing to answer under it', async () => {
    // `connectReplicaKeeper`'s own docstring: a token rotation must forget
    // whatever key the PREVIOUS connection held. A fetch double that mints a
    // DIFFERENT workspace key each call is the differential signal — if the
    // stale key kept answering, the old ciphertext would still open; if it
    // was really forgotten, opening it with the freshly-minted key fails.
    const workspaceId = freshWorkspaceId()
    const docRef: DocRef = { kind: 'workspace-tree', workspaceId }
    let keyCalls = 0
    const rotatingKeyFetch: typeof fetch = (async (input: Request | string | URL) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.endsWith('/replica-key')) {
        keyCalls += 1
        const seed = keyCalls === 1 ? 1 : 200
        return jsonResponse({
          workspaceKey: b64u(Uint8Array.from({ length: 32 }, (_, i) => seed + i)),
          workspaceKeySalt: b64u(WORKSPACE_SALT),
          tier: 'offline',
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    }) as typeof fetch

    connectReplicaKeeper({ baseUrl: DAEMON, token: 'tok-1', fetch: rotatingKeyFetch })
    markReplica(workspaceId, DAEMON)
    const store = openDocumentStore(DB_NAME)
    const { manifest, chunks } = chunkSnapshot(new TextEncoder().encode(marker), 200)
    await store.saveSnapshot({ docRef, manifest, chunks, frontier: new Uint8Array(4) })
    expect(keyCalls).toBe(1)

    // Still held: reads back without another key fetch.
    const loaded = await store.loadSnapshot({ docRef })
    expect(loaded?.chunks.map((c) => new TextDecoder().decode(c.bytes))).toEqual([marker])
    expect(keyCalls).toBe(1)

    // A token rotation on the SAME daemon — must forget the first key.
    connectReplicaKeeper({ baseUrl: DAEMON, token: 'tok-2', fetch: rotatingKeyFetch })

    await expect(store.loadSnapshot({ docRef })).rejects.toBeInstanceOf(
      StoredDocumentUnreadableError,
    )
    expect(keyCalls).toBe(2)
  })
})
