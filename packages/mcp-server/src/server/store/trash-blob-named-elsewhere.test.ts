import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordTrashEntry } from '@kamiazya/whiteboard-loro-adapter'
import { DocumentStoreWorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureLogsForTests } from '../log.js'
import { createIsolatedDb } from './db/test-helpers.js'
import { storeScope } from './store-scope.js'
import { trashBlobNamedElsewhere } from './trash-blob-named-elsewhere.js'
import { _clearWorkspaceDocCacheForTests, saveWorkspaceDoc } from './workspace-doc-cache.js'

const REF = { algorithm: 'sha-256', digestHex: 'a'.repeat(64) } as const
const OTHER_REF = { algorithm: 'sha-256', digestHex: 'b'.repeat(64) } as const

let dir: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trash-named-elsewhere-'))
  handle = await createIsolatedDb({ dataDir: dir })
  _clearWorkspaceDocCacheForTests()
})
afterEach(async () => {
  vi.restoreAllMocks()
  _clearWorkspaceDocCacheForTests()
  await handle.dispose()
  await rm(dir, { recursive: true, force: true })
})

async function storeRecordNaming(
  workspaceId: string,
  ref: { algorithm: 'sha-256'; digestHex: string },
  documentId = '01BRWAAAAAAAAAAAAAAAAAAAA2',
): Promise<void> {
  const doc = new LoroDoc()
  recordTrashEntry(doc, {
    documentId,
    path: 'gone',
    deletedAt: 1,
    blob: ref,
  })
  doc.commit()
  await saveWorkspaceDoc(workspaceId, doc, storeScope(dir))
}

it("answers yes for a blob another workspace's trash names", async () => {
  await storeRecordNaming('ws-a', REF)
  await storeRecordNaming('ws-b', REF)

  expect(await trashBlobNamedElsewhere(storeScope(dir))({ workspaceId: 'ws-a', ref: REF })).toBe(
    true,
  )
})

it('looks past a registered workspace with no stored record', async () => {
  await storeRecordNaming('ws-a', REF)
  const now = Date.now()
  await handle.db
    .insertInto('workspaces')
    .values({ id: 'ws-0', createdAt: now, updatedAt: now })
    .execute()
  await storeRecordNaming('ws-b', REF)

  expect(await trashBlobNamedElsewhere(storeScope(dir))({ workspaceId: 'ws-a', ref: REF })).toBe(
    true,
  )
})

it("does not count the asking workspace's own rows, nor another blob", async () => {
  await storeRecordNaming('ws-a', REF)
  await storeRecordNaming('ws-b', OTHER_REF)

  expect(await trashBlobNamedElsewhere(storeScope(dir))({ workspaceId: 'ws-a', ref: REF })).toBe(
    false,
  )
})

it('keeps the blob, and says why, when another workspace record will not open', async () => {
  const logs = captureLogsForTests('warning')
  try {
    await storeRecordNaming('ws-a', REF)
    await storeRecordNaming('ws-b', OTHER_REF)
    vi.spyOn(DocumentStoreWorkspaceDocs.prototype, 'open').mockRejectedValue(new Error('torn'))

    expect(await trashBlobNamedElsewhere(storeScope(dir))({ workspaceId: 'ws-a', ref: REF })).toBe(
      true,
    )
    expect(logs.records.map((record) => record.data?.workspaceId)).toContain('ws-b')
  } finally {
    logs.restore()
  }
})

describe('cost of one answer', () => {
  const OTHERS = 8

  async function storeOthers(): Promise<void> {
    await storeRecordNaming('ws-a', REF)
    for (let i = 0; i < OTHERS; i += 1) await storeRecordNaming(`ws-other-${i}`, OTHER_REF)
  }

  it('decodes no unchanged record on a repeated purge', async () => {
    await storeOthers()
    const ask = trashBlobNamedElsewhere(storeScope(dir))
    await ask({ workspaceId: 'ws-a', ref: REF })
    const open = vi.spyOn(DocumentStoreWorkspaceDocs.prototype, 'open')

    expect(await ask({ workspaceId: 'ws-a', ref: REF })).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('reads again, alone, a record that changed since the last answer', async () => {
    await storeOthers()
    const ask = trashBlobNamedElsewhere(storeScope(dir))
    expect(await ask({ workspaceId: 'ws-a', ref: REF })).toBe(false)
    await storeRecordNaming('ws-other-3', REF, '01BRWAAAAAAAAAAAAAAAAAAAA3')
    const open = vi.spyOn(DocumentStoreWorkspaceDocs.prototype, 'open')

    expect(await ask({ workspaceId: 'ws-a', ref: REF })).toBe(true)
    expect(open.mock.calls).toEqual([['ws-other-3']])
  })
})
