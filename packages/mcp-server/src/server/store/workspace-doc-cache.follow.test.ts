/**
 * Following the live workspace record for its audience: where the follower
 * stood goes in, where it stands now and the bytes the audience has not been
 * sent come out. On first sight the live record is reconciled from the store and
 * only what it GAINED is sent (a client already holds the rest); after that,
 * what the store gained since the cursor. The record is lent for the whole
 * catch-up, and nothing is out afterwards.
 */

import './_test-loro-records.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workspaceIdFor } from '@kamiazya/whiteboard-model/test-utils'
import {
  DocumentStoreWorkspaceDocs,
  RecordStoreWorkspaceDocs,
} from '@kamiazya/whiteboard-workspace-index'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempDir: string
vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const {
  followWorkspaceRecord,
  onWorkspaceDocUpdated,
  getWorkspaceDoc,
  saveWorkspaceDoc,
  _clearWorkspaceDocCacheForTests,
  _workspaceRecordLoansForTests,
} = await import('./workspace-doc-cache.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')
const { getDb } = await import('./db/index.js')
const { LibsqlDocumentStore } = await import('./libsql/libsql-document-store.js')
const { globalStoreScope } = await import('./store-scope.js')

const WS = workspaceIdFor('follow')
let handle: Awaited<ReturnType<typeof createIsolatedDb>>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'ws-doc-follow-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  _clearWorkspaceDocCacheForTests()
})
afterEach(async () => {
  _clearWorkspaceDocCacheForTests()
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

/** Another instance's write: its own copy of the stored record, saved straight to the store. */
async function foreignWrite(key: string, value: string): Promise<void> {
  const docs = new DocumentStoreWorkspaceDocs(new LibsqlDocumentStore(await getDb(tempDir)))
  const record = (await docs.open(WS)) ?? new LoroDoc()
  record.getMap('meta').set(key, value)
  record.commit()
  await docs.save(WS, record)
}

/**
 * What reaches an audience while `work` runs: the bytes the follow answers and
 * the ones the cache announces through the funnel when it catches the record up
 * to serve it, which is the same audience's other way in.
 */
async function heardDuring<T extends { updates: readonly Uint8Array[] }>(
  work: () => Promise<T>,
): Promise<{ result: T; heard: Uint8Array[] }> {
  const announced: Uint8Array[] = []
  const stop = onWorkspaceDocUpdated((_workspaceId, update) => announced.push(update))
  try {
    const result = await work()
    return { result, heard: [...announced, ...result.updates] }
  } finally {
    stop()
  }
}

describe('following the live workspace record', () => {
  it('sends nothing on first sight when the live record is level with the store', async () => {
    const live = await getWorkspaceDoc(WS)
    live.getMap('meta').set('own', '1')
    live.commit()
    await saveWorkspaceDoc(WS, live)

    const first = await followWorkspaceRecord(WS, globalStoreScope, undefined)

    expect(first.updates).toEqual([])
    expect(first.cursor).toBeDefined()
    expect(_workspaceRecordLoansForTests()).toBe(0)
  })

  it('sends on first sight what the live record gained from the store, which the audience lacks', async () => {
    const live = await getWorkspaceDoc(WS)
    live.getMap('meta').set('own', '1')
    live.commit()
    await saveWorkspaceDoc(WS, live)
    const replica = new LoroDoc()
    replica.import(live.export({ mode: 'snapshot' }))
    await foreignWrite('remote', '1')

    const { heard } = await heardDuring(() =>
      followWorkspaceRecord(WS, globalStoreScope, undefined),
    )
    expect(heard.length).toBeGreaterThan(0)
    for (const update of heard) replica.import(update)
    expect(replica.getMap('meta').toJSON()).toEqual(live.getMap('meta').toJSON())
    expect(live.getMap('meta').get('remote')).toBe('1')
    expect(_workspaceRecordLoansForTests()).toBe(0)
  })

  it('sends on first sight what a write landing after the lend added, which nothing else announces', async () => {
    const live = await getWorkspaceDoc(WS)
    live.getMap('meta').set('own', '1')
    live.commit()
    await saveWorkspaceDoc(WS, live)
    const replica = new LoroDoc()
    replica.import(live.export({ mode: 'snapshot' }))
    // The lend has caught the record up by the time the reconcile reads the log,
    // so a write has to land between the two to leave anything to send.
    const read = LibsqlDocumentStore.prototype.loadDeltas
    let landed = false
    const spy = vi
      .spyOn(LibsqlDocumentStore.prototype, 'loadDeltas')
      .mockImplementation(async function (this: InstanceType<typeof LibsqlDocumentStore>, ...args) {
        if (!landed) {
          landed = true
          await foreignWrite('late', '1')
        }
        return read.apply(this, args)
      })

    const { result } = await heardDuring(() =>
      followWorkspaceRecord(WS, globalStoreScope, undefined),
    ).finally(() => spy.mockRestore())

    expect(result.updates.length).toBeGreaterThan(0)
    for (const update of result.updates) replica.import(update)
    expect(replica.getMap('meta').get('late')).toBe('1')
  })

  it('sends what the store gained since the cursor, and nothing when it gained nothing', async () => {
    const live = await getWorkspaceDoc(WS)
    live.getMap('meta').set('own', '1')
    live.commit()
    await saveWorkspaceDoc(WS, live)
    const replica = new LoroDoc()
    replica.import(live.export({ mode: 'snapshot' }))
    const first = await followWorkspaceRecord(WS, globalStoreScope, undefined)

    const quiet = await followWorkspaceRecord(WS, globalStoreScope, first.cursor)
    expect(quiet.updates).toEqual([])

    await foreignWrite('remote', '2')
    const { heard } = await heardDuring(() =>
      followWorkspaceRecord(WS, globalStoreScope, quiet.cursor),
    )
    for (const update of heard) replica.import(update)
    expect(heard.length).toBeGreaterThan(0)
    expect(replica.getMap('meta').get('remote')).toBe('2')
    expect(_workspaceRecordLoansForTests()).toBe(0)
  })

  it('gives its loan back when the catch-up fails', async () => {
    await getWorkspaceDoc(WS)
    const failing = vi
      .spyOn(RecordStoreWorkspaceDocs.prototype, 'catchUp')
      .mockRejectedValueOnce(new Error('store gone'))

    await expect(followWorkspaceRecord(WS, globalStoreScope, undefined)).rejects.toThrow(
      'store gone',
    )
    failing.mockRestore()

    expect(_workspaceRecordLoansForTests()).toBe(0)
  })
})
