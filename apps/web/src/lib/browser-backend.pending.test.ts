/**
 * What a Browser-kept document was handed and has not saved survives the tab
 * that held it. The first backend's save never completes, as a tab closed
 * inside the save's asynchronous chain never completes it; a second backend
 * over the same IndexedDB, as the reopened tab builds, replays what the first
 * left and delivers it in its snapshot.
 */
import 'fake-indexeddb/auto'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readMarkdownBody,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { docOf, leaseOf } from '../test-utils/replica-lease.js'
import { BrowserBackend } from './browser-backend.js'
import { forgetPendingUpdates, PendingUpdates } from './browser-pending-updates.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'

vi.mock('./content-timestamp.js', () => ({ touchContentTimestamp: async () => {} }))

const DB = claimIsolatedWhiteboardDb('browser-backend-pending')
const TARGET = {
  documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  path: 'notes',
  kind: 'markdown' as const,
}
const WS = getBrowserWorkspaceId()
/** The size past which an update is not logged: one mebibyte. */
const CAP = 1024 * 1024

function seed(): LoroDoc {
  const record = new LoroDoc()
  createWorkspaceDocumentAtPath(record, {
    path: TARGET.path,
    documentId: TARGET.documentId,
    kind: 'markdown',
  })
  writeMarkdownBody(documentContainers(record, TARGET.documentId), 'start')
  record.commit()
  return record
}

/** A store over bytes the test reads back; `hang` makes a save that never completes. */
function storeOf(persisted: { bytes: Uint8Array }, hang: boolean) {
  return {
    create: async () => leaseOf(LoroDoc.fromSnapshot(persisted.bytes)),
    save: async (_ws: string, record: Parameters<typeof docOf>[0]) => {
      if (hang) return new Promise<never>(() => {})
      persisted.bytes = docOf(record).export({ mode: 'snapshot' })
      return null
    },
    catchUp: async (_ws: string, _record: unknown, cursor: unknown) => ({ cursor, updates: [] }),
  } as unknown as ConstructorParameters<typeof BrowserBackend>[1]
}

async function connect(docs: ConstructorParameters<typeof BrowserBackend>[1]) {
  const backend = new BrowserBackend(TARGET, docs)
  let snapshot: Uint8Array | null = null
  backend.connect({
    onConnected: () => {},
    onSnapshot: (bytes: Uint8Array) => {
      snapshot = bytes
    },
    onRemoteUpdate: () => {},
    onError: () => {},
  } as never)
  await vi.waitFor(() => expect(snapshot).not.toBeNull())
  return { backend, session: LoroDoc.fromSnapshot(snapshot as unknown as Uint8Array) }
}

const bodyOf = (doc: LoroDoc) => readMarkdownBody(documentContainers(doc, TARGET.documentId))

function typed(session: LoroDoc, text: string): Uint8Array {
  const from = session.oplogVersion()
  documentContainers(session, TARGET.documentId).getText('body').insert(0, text)
  session.commit()
  return session.export({ mode: 'update', from })
}

async function entries() {
  const log = new PendingUpdates(`${DB}-pending`)
  const found = await log.list(WS, TARGET.documentId)
  log.close()
  return found
}

beforeEach(clearWhiteboardDb)

describe('an update a Browser-kept document was handed before the tab went away', () => {
  it('is replayed into the next connection, whose snapshot carries it', async () => {
    const persisted = { bytes: seed().export({ mode: 'snapshot' }) }
    const first = await connect(storeOf(persisted, true))
    void first.backend.pushLocalUpdate(typed(first.session, 'lost? '))
    await vi.waitFor(async () => expect((await entries()).length).toBe(1))
    first.backend.disconnect()

    const second = await connect(storeOf(persisted, false))

    expect(bodyOf(second.session)).toContain('lost? ')
    expect(bodyOf(LoroDoc.fromSnapshot(persisted.bytes))).toContain('lost? ')
    second.backend.disconnect()
  })

  it('is forgotten once its save has landed, so nothing is replayed', async () => {
    const persisted = { bytes: seed().export({ mode: 'snapshot' }) }
    const gate = { open: () => {} }
    const waiting = new Promise<void>((resolve) => {
      gate.open = resolve
    })
    const docs = storeOf(persisted, false)
    const save = (docs as unknown as { save: (...a: unknown[]) => Promise<unknown> }).save
    ;(docs as unknown as { save: unknown }).save = async (...args: unknown[]) => {
      await waiting
      return save(...args)
    }
    const first = await connect(docs)
    const pushed = first.backend.pushLocalUpdate(typed(first.session, 'kept '))
    await vi.waitFor(async () => expect((await entries()).length).toBe(1))

    gate.open()
    await pushed

    await vi.waitFor(async () => expect(await entries()).toEqual([]))
    first.backend.disconnect()
  })

  it('is not logged past the size cap, which takes the ordinary path alone', () => {
    const log = new PendingUpdates(`${DB}-pending`)
    return log.open().then(() => {
      expect(log.put(WS, TARGET.documentId, new Uint8Array(CAP + 1))).toBeNull()
      expect(log.put(WS, TARGET.documentId, new Uint8Array(8))).not.toBeNull()
      log.close()
    })
  })

  it('keeps two tabs that log in the same millisecond apart', async () => {
    // Two page loads are two module instances, so each counts from one.
    vi.useFakeTimers({ toFake: ['Date'], now: 1_700_000_000_000 })
    try {
      const logs = []
      for (const _ of [0, 1]) {
        vi.resetModules()
        const { PendingUpdates: Fresh } = await import('./browser-pending-updates.js')
        const log = new Fresh(`${DB}-pending`)
        await log.open()
        logs.push(log)
      }
      const a = logs[0]?.put(WS, TARGET.documentId, new Uint8Array([1]))
      const b = logs[1]?.put(WS, TARGET.documentId, new Uint8Array([2]))
      expect(a).not.toBeNull()
      expect(b).not.toBeNull()
      expect(await logs[0]?.list(WS, TARGET.documentId)).toHaveLength(2)
      for (const log of logs) log?.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('what a removed record would leave in the log', () => {
  async function logged(workspaceId: string, documentId: string) {
    const log = new PendingUpdates(`${DB}-pending`)
    await log.open()
    log.put(workspaceId, documentId, new Uint8Array(8))
    await log.close()
  }

  it('is forgotten for one document, and for a whole workspace, and for nothing else', async () => {
    await logged(WS, 'doc-a')
    await logged(WS, 'doc-b')
    await logged('other-workspace', 'doc-a')
    const count = async (workspaceId: string, documentId: string) => {
      const log = new PendingUpdates(`${DB}-pending`)
      const found = await log.list(workspaceId, documentId)
      log.close()
      return found.length
    }
    await vi.waitFor(async () => expect(await count(WS, 'doc-b')).toBe(1))

    await forgetPendingUpdates(WS, 'doc-a', DB)
    expect([await count(WS, 'doc-a'), await count(WS, 'doc-b')]).toEqual([0, 1])

    await forgetPendingUpdates(WS, undefined, DB)
    expect([await count(WS, 'doc-b'), await count('other-workspace', 'doc-a')]).toEqual([0, 1])
  })
})
