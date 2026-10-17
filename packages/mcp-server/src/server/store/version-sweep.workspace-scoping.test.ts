/**
 * The two places a document's saved versions are swept — the trash purge
 * and the teardown of a delete that left nothing to restore — must sweep
 * only the workspace the document was deleted from.
 *
 * A documentId is not unique across workspaces: a promote carries the
 * browser's ids into the daemon, and a member can write any id into their
 * own workspace's synced trash. So every case here seeds a neighbour
 * workspace holding versions under the SAME documentId, and a sweep keyed
 * on documentId alone would take them.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteWorkspaceNodeAtPath } from '@kamiazya/whiteboard-loro-adapter'
import { hasDocumentTrash } from '@kamiazya/whiteboard-ports'
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

const { FileVersionStore } = await import('./version-store.js')
const { getDb } = await import('./db/index.js')
const { prepareDataDir } = await import('./db/prepare.js')
const { createContainer, resolveServerDeps } = await import('../../di/container.js')
const { createSelfHostStoreLocalModule } = await import('../../di/store-local.module.js')
const { wbDocumentCreate, wbDocumentDelete } = await import('@kamiazya/whiteboard-server-core')

async function setUp() {
  await prepareDataDir(tempDir)
  const db = await getDb(tempDir)
  const deps = resolveServerDeps(createContainer(createSelfHostStoreLocalModule(db, tempDir)))
  await deps.documentIndex.createWorkspace({ workspaceId: 'ws-a' })
  await deps.documentIndex.createWorkspace({ workspaceId: 'ws-b' })
  const created = await wbDocumentCreate(deps, {
    workspaceId: 'ws-a',
    path: 'doomed',
    kind: 'spatial',
  })
  const versions = new FileVersionStore()
  const own = await versions.save('ws-a', 'doomed', new LoroDoc(), { auto: false })
  const ownRow = await db
    .selectFrom('versions')
    .selectAll()
    .where('id', '=', own.id)
    .executeTakeFirstOrThrow()
  await db
    .insertInto('versions')
    .values({ ...ownRow, id: 'neighbour-version', workspaceId: 'ws-b' })
    .execute()
  const rowsOf = async (workspaceId: string) =>
    (
      await db
        .selectFrom('versions')
        .select('id')
        .where('workspaceId', '=', workspaceId)
        .where('documentId', '=', created.documentId)
        .execute()
    ).map((row) => row.id)
  // The fixture reaches the subject: both workspaces hold a row under the id.
  expect(await rowsOf('ws-a')).toEqual([own.id])
  expect(await rowsOf('ws-b')).toEqual(['neighbour-version'])
  return { deps, documentId: created.documentId, rowsOf }
}

describe('sweeping a deleted document’s versions', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-version-sweep-scoping-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('a purge leaves a neighbour workspace’s versions under the same document id', async () => {
    const { deps, documentId, rowsOf } = await setUp()
    await wbDocumentDelete(deps, { workspaceId: 'ws-a', documentId })
    if (!hasDocumentTrash(deps.documentIndex)) throw new Error('store-local index has a trash')
    expect(await deps.documentIndex.purgeTrashEntry({ workspaceId: 'ws-a', documentId })).toBe(true)
    expect(await rowsOf('ws-a')).toEqual([])
    expect(await rowsOf('ws-b')).toEqual(['neighbour-version'])
  })

  it('a trash-less teardown leaves a neighbour workspace’s versions under the same document id', async () => {
    const { deps, documentId, rowsOf } = await setUp()
    await deps.documentTeardown.around(
      { workspaceId: 'ws-a', documentId, path: 'doomed' },
      async () => {
        const record = await deps.workspaceDocuments.get('ws-a')
        expect(deleteWorkspaceNodeAtPath(record, 'doomed')).toBe(true)
        await deps.workspaceDocuments.save('ws-a', record)
      },
    )
    expect(await rowsOf('ws-a')).toEqual([])
    expect(await rowsOf('ws-b')).toEqual(['neighbour-version'])
  })
})
