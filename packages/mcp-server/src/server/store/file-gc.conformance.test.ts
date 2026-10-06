/**
 * The daemon's half of the cross-keeper file-collection scenario: the steps
 * are the shared ones, taken through this keeper's own store, and the verdict
 * must be the one the browser's sweep reaches in
 * `apps/web/src/lib/browser-file-sweep.browser.test.tsx`.
 */
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FILE_COLLECTION_CONFORMANCE } from '@kamiazya/whiteboard-loro-adapter/test-utils/file-collection-conformance'
import { newImageRef } from '@kamiazya/whiteboard-model'
import { fileNode } from '@kamiazya/whiteboard-model/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { workspaceFilesDir } from '../tenant/data-layout.js'
import { SELF_HOST_TENANT_ID } from '../tenant/id.js'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { deleteDocument, loadDocument, resolveDocumentIdAtPath, saveDocument, workspaceTreeIndex } =
  await import('./document-store.js')
const { purgeDanglingFiles } = await import('./file-gc.js')
const { FileVersionStore } = await import('./version-store.js')
const { globalStoreScope } = await import('./store-scope.js')
const { createIsolatedDb } = await import('./db/test-helpers.js')
const { makeSpatialDoc } = await import('../../shared/test-utils/spatial-doc.js')

const WORKSPACE = 'ws_conformance'

let handle: Awaited<ReturnType<typeof createIsolatedDb>>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-file-gc-conformance-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
})

afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

function drawing(fileIds: readonly string[]) {
  return makeSpatialDoc({
    nodes: fileIds.map((id, i) =>
      fileNode({ id: `n-${id}`, file: newImageRef(id), x: i * 20, y: 0, width: 10, height: 10 }),
    ),
    edges: [],
  })
}

/** Written and aged past the default grace window, as `upload` declares. */
async function upload(fileId: string): Promise<void> {
  const dir = workspaceFilesDir(tempDir, SELF_HOST_TENANT_ID, WORKSPACE)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${fileId}.png`)
  await writeFile(path, Buffer.from(`png:${fileId}`))
  const past = (Date.now() - 2 * 60 * 60 * 1000) / 1000
  await utimes(path, past, past)
}

it('reaches the verdict every keeper reaches on the shared scenario', async () => {
  const versions = new FileVersionStore()
  const trashedIds = new Map<string, string>()
  for (const step of FILE_COLLECTION_CONFORMANCE.steps) {
    switch (step.op) {
      case 'upload':
        await upload(step.fileId)
        break
      case 'create':
        await saveDocument(WORKSPACE, step.path, drawing(step.draws))
        break
      case 'draw':
        await saveDocument(WORKSPACE, step.path, drawing(step.draws), { overwrite: true })
        break
      case 'save-version':
        await versions.save(WORKSPACE, step.path, await loadDocument(WORKSPACE, step.path), {
          auto: false,
        })
        break
      case 'delete':
        trashedIds.set(step.path, (await resolveDocumentIdAtPath(WORKSPACE, step.path)) ?? '')
        expect(await deleteDocument(WORKSPACE, step.path)).toBe(true)
        break
      case 'purge': {
        const index = await workspaceTreeIndex(globalStoreScope)
        const documentId = trashedIds.get(step.path) ?? ''
        expect(await index.purgeTrashEntry({ workspaceId: WORKSPACE, documentId })).toBe(true)
        break
      }
    }
  }

  const result = await purgeDanglingFiles(WORKSPACE, { versionStore: versions })

  expect(result.purgedCount).toBe(FILE_COLLECTION_CONFORMANCE.collected.length)
  const remaining = await readdir(workspaceFilesDir(tempDir, SELF_HOST_TENANT_ID, WORKSPACE))
  expect(remaining.sort()).toEqual(
    FILE_COLLECTION_CONFORMANCE.kept.map((fileId) => `${fileId}.png`).sort(),
  )
})
