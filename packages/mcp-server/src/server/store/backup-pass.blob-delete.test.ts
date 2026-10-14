import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TOKENS } from '@kamiazya/whiteboard-ports'
import { LoroWorkspaceDocumentIndex } from '@kamiazya/whiteboard-workspace-index'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createContainer } from '../../di/container.js'
import { createSelfHostStoreLocalModule } from '../../di/store-local.module.js'
import { SELF_HOST_TENANT_ID } from '../tenant/id.js'
import { performBackup } from './backup-pass.js'
import { closeDb, getDb } from './db/index.js'
import { prepareDataDir } from './db/prepare.js'
import { snapshotDatabaseInto } from './db/snapshot.js'
import { workspaceTreeIndex } from './document-store.js'
import { storeScope } from './store-scope.js'

let root: string
let dataDir: string
let backupRoot: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'wb-backup-blob-delete-')))
  dataDir = join(root, 'data')
  backupRoot = join(root, 'backups')
  await mkdir(dataDir, { recursive: true })
  await mkdir(backupRoot, { recursive: true })
  await prepareDataDir(dataDir)
})
afterEach(async () => {
  await closeDb(dataDir)
  await rm(root, { recursive: true, force: true })
})

/** Both places the daemon hands the tree index its blob store. */
const INDEX_SOURCES: Record<string, () => Promise<LoroWorkspaceDocumentIndex>> = {
  'the container binding': async () => {
    const container = createContainer(createSelfHostStoreLocalModule(await getDb(dataDir), dataDir))
    const index = container.get(TOKENS.DocumentIndex)
    // The trash half is the tree index's own surface, not the port's.
    if (!(index instanceof LoroWorkspaceDocumentIndex)) throw new Error('not the tree index')
    return index
  },
  workspaceTreeIndex: () => workspaceTreeIndex(storeScope(dataDir, SELF_HOST_TENANT_ID)),
}

async function trashedDocument(index: LoroWorkspaceDocumentIndex): Promise<string> {
  await index.createWorkspace({ workspaceId: 'ws' })
  await index.createDocument({ workspaceId: 'ws', path: 'doomed', kind: 'markdown' })
  await index.deleteDocument({ workspaceId: 'ws', path: 'doomed' })
  const [entry] = await index.listTrash({ workspaceId: 'ws' })
  if (entry === undefined) throw new Error('the delete left no trash row')
  return entry.documentId
}

/** A backup whose snapshot is followed, before the mirror, by `between`. */
async function backupWith(between: () => Promise<unknown>): Promise<string[]> {
  const outputDir = join(backupRoot, '2026-03-04T00-00-00.000Z')
  const outcome = await performBackup({
    dataDir,
    outputDir,
    mirrorRoot: backupRoot,
    doSnapshot: async (dir, dest) => {
      await snapshotDatabaseInto(dir, dest)
      await between()
    },
  })
  expect(outcome.kind).toBe('ok')
  const manifest = JSON.parse(await readFile(join(outputDir, 'blobs.json'), 'utf8'))
  return manifest.tenants[SELF_HOST_TENANT_ID].blobs
}

describe('a trash blob deleted between a backup snapshot and its mirror', () => {
  for (const [source, openIndex] of Object.entries(INDEX_SOURCES)) {
    it(`is still mirrored when purged through ${source}`, async () => {
      const index = await openIndex()
      const documentId = await trashedDocument(index)
      const [entry] = await index.listTrash({ workspaceId: 'ws' })

      const mirrored = await backupWith(() =>
        index.purgeTrashEntry({ workspaceId: 'ws', documentId }),
      )

      // The snapshot holds the row, so the mirror must hold its bytes.
      expect(mirrored).toContain(entry?.blob.digestHex)
    })
  }

  it('is still mirrored when the document is restored', async () => {
    const index = await INDEX_SOURCES['the container binding']!()
    const documentId = await trashedDocument(index)
    const [entry] = await index.listTrash({ workspaceId: 'ws' })

    const mirrored = await backupWith(() =>
      index.restoreDocument({ workspaceId: 'ws', documentId }),
    )

    expect(mirrored).toContain(entry?.blob.digestHex)
  })
})
