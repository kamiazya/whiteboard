import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  documentIdAt,
  resolveTestServerDeps,
  testDocumentRouterOptions,
  withTempDataDir,
  writeDocumentUpdate,
} from '../_test-helpers.js'

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const tmp = withTempDataDir('whiteboard-restore-points-test-')

let serverDeps: ServerDeps
beforeEach(async () => {
  serverDeps = await resolveTestServerDeps(tmp.dir)
  await serverDeps.documentIndex.createWorkspace({ workspaceId: '01M8BBN7JS60N0ZAR13NP8SXBF' })
})

const { createDocumentRouter } = await import('../document.js')
// Pre-loaded for the same dynamic-import cycle restore.test.ts works around.
await import('../../sync-audience.js')

const createRouter = () =>
  createDocumentRouter(testDocumentRouterOptions({ serverDeps, autoVersionQuietMs: 60_000 }))

function nodesModelDocUpdate(nodeIds: string[]): Uint8Array<ArrayBuffer> {
  const doc = new LoroDoc()
  const vv0 = doc.version()
  writeSpatialCanvas(doc, {
    nodes: nodeIds.map((id) => textNode({ id, text: id, x: 0, y: 0, width: 10, height: 10 })),
    edges: [],
  })
  return doc.export({ mode: 'update', from: vv0 }) as Uint8Array<ArrayBuffer>
}

const WS = '01M8BBN7JS60N0ZAR13NP8SXBF'
const { installAutoCheckpoint, uninstallAutoCheckpointForTests } = await import(
  '../../store/auto-checkpoint.js'
)
const { createAutoVersionTrigger } = await import('../../store/auto-version.js')
const { setDocumentSavedListener } = await import('../../store/document-store.js')
const autoCompact = await import('../../store/auto-compact.js')
const { FileVersionStore } = await import('../../store/version-store.js')
const { testStoreScope } = await import('../_test-helpers.js')

afterEach(() => {
  uninstallAutoCheckpointForTests()
  setDocumentSavedListener(null)
  vi.restoreAllMocks()
})

// What the history and the compaction scheduler are told by an in-place
// restore, with the real checkpoint scheduler armed over a short quiet window:
// the version list afterwards holds the two saves and the restore's own merge
// point, and no automatic row the restore did not need.
describe('an in-place restore with the checkpoint scheduler armed', () => {
  async function restoreWithSchedulerArmed() {
    const app = createRouter()
    await writeDocumentUpdate(serverDeps, WS, 'canvas-a', nodesModelDocUpdate(['v1-node']))
    const documentId = await documentIdAt(serverDeps, WS, 'canvas-a')
    const save = async (label: string) => {
      const res = await app.request(`/api/workspaces/${WS}/documents/${documentId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      })
      return ((await res.json()) as { version: { id: string } }).version.id
    }
    const v1 = await save('v1')
    await writeDocumentUpdate(serverDeps, WS, 'canvas-a', nodesModelDocUpdate(['after-v1']))
    await save('v2')

    const scheduler = createAutoVersionTrigger(new FileVersionStore(testStoreScope()), {
      quietMs: 40,
      ceilingMs: 80,
    })
    installAutoCheckpoint(scheduler)
    // The two ways a compaction gets scheduled: the store's saved-listener,
    // and the written observer a root hands the operations.
    let compactionsScheduled = 0
    setDocumentSavedListener(() => {
      compactionsScheduled += 1
    })
    vi.spyOn(autoCompact, 'scheduleAutoCompact').mockImplementation(() => {
      compactionsScheduled += 1
    })

    const res = await app.request(
      `/api/workspaces/${WS}/documents/${documentId}/versions/${v1}/restore`,
      { method: 'POST' },
    )
    expect(res.status).toBe(200)
    // Every checkpoint the restore left pending is taken now, rather than after a pause.
    await scheduler.flush()
    const rows = await serverDeps.versions.list(WS, 'canvas-a')
    return { rows, compactionsScheduled }
  }

  it('leaves the history with the saves and the restore point, and no further automatic row', async () => {
    const { rows } = await restoreWithSchedulerArmed()
    expect(
      rows
        .map((row) => (row.restoredFrom !== undefined ? 'restore-point' : (row.label ?? 'auto')))
        .sort(),
    ).toEqual(['restore-point', 'v1', 'v2'])
  })

  it('schedules the compaction once', async () => {
    const { compactionsScheduled } = await restoreWithSchedulerArmed()
    expect(compactionsScheduled).toBe(1)
  })
})
