import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CheckpointScheduler, createCheckpointScheduler } from '@kamiazya/whiteboard-history'
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

const { getDb } = await import('./db/index.js')
const { prepareDataDir } = await import('./db/prepare.js')
const { installAutoCheckpoint, uninstallAutoCheckpointForTests } = await import(
  './auto-checkpoint.js'
)
const { disposeAutoCompact } = await import('./auto-compact.js')
const { createContainer, resolveServerDeps } = await import('../../di/container.js')
const { createSelfHostStoreLocalModule } = await import('../../di/store-local.module.js')
const { renameDocumentPath, deleteDocument } = await import('./document-store.js')
const { wbDocumentCreate, wbDocumentMove, wbDocumentDelete, createCanvasEditTool } = await import(
  '@kamiazya/whiteboard-server-core'
)

// Through the real container and the real tools, because the gap was never in
// the scheduler's arithmetic — nothing told it a path had changed. The scheduler
// is the shared one with a recording `save`, so what is asserted is where a
// pending checkpoint lands once a document has moved or gone, not a mock call.
describe('a pending automatic checkpoint when its document moves or is deleted', () => {
  const saved: string[] = []
  const failed: string[] = []
  let scheduler: CheckpointScheduler

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wb-checkpoint-path-'))
    saved.length = 0
    failed.length = 0
    scheduler = createCheckpointScheduler<void>({
      quietMs: 60_000,
      save: async (_workspaceId, path) => {
        saved.push(path)
      },
      onError: (_err, { path }) => failed.push(path),
    })
    installAutoCheckpoint(scheduler)
  })

  afterEach(async () => {
    uninstallAutoCheckpointForTests()
    await disposeAutoCompact()
    await rm(tempDir, { recursive: true, force: true })
  })

  async function editedDocument(path: string) {
    await prepareDataDir(tempDir)
    const db = await getDb(tempDir)
    const deps = resolveServerDeps(createContainer(createSelfHostStoreLocalModule(db, tempDir)))
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-1' })
    const created = await wbDocumentCreate(deps, { workspaceId: 'ws-1', path, kind: 'spatial' })
    await createCanvasEditTool(deps).execute({
      workspaceId: 'ws-1',
      documentId: created.documentId,
      ops: [
        {
          op: 'node.add',
          node: { id: 'n1', type: 'text', text: 'hi', x: 0, y: 0, width: 80, height: 40 },
        },
      ],
    })
    return { deps, documentId: created.documentId }
  }

  it('takes the checkpoint under the new path after a move through the tool', async () => {
    const { deps, documentId } = await editedDocument('before')
    await wbDocumentMove(deps, { workspaceId: 'ws-1', documentId, path: 'after' })
    await scheduler.flush()
    expect(saved).toEqual(['after'])
    expect(failed).toEqual([])
  })

  it('takes the checkpoint under the new path after the daemon rename path', async () => {
    await editedDocument('before')
    await renameDocumentPath('ws-1', 'before', 'after')
    await scheduler.flush()
    expect(saved).toEqual(['after'])
    expect(failed).toEqual([])
  })

  it('drops the checkpoint of a document deleted through the tool, without reporting a failure', async () => {
    const { deps, documentId } = await editedDocument('doomed')
    await wbDocumentDelete(deps, { workspaceId: 'ws-1', documentId })
    await scheduler.flush()
    expect(saved).toEqual([])
    expect(failed).toEqual([])
  })

  it('drops the checkpoint of a document deleted through the daemon path', async () => {
    await editedDocument('doomed')
    await deleteDocument('ws-1', 'doomed')
    await scheduler.flush()
    expect(saved).toEqual([])
    expect(failed).toEqual([])
  })
})
