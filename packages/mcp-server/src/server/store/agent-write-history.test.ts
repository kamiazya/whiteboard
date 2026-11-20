// What an agent write leaves in the history: the row `wb_version_save` records
// (element count, the record's frontier, the content digest), what the
// document-written observer is told, and which writes the automatic checkpoint
// takes. Through the production container, since each is a join between the
// tool in server-core and a keeper in this package.
import {
  createCanvasEditTool,
  type DocumentWritten,
  type ServerDeps,
} from '@kamiazya/whiteboard-server-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveTestServerDeps, withTempDataDir } from '../routes/_test-helpers.js'

const tmp = withTempDataDir('whiteboard-agent-history-')

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createWorkspaceEditTool, createVersionSaveTool } = await import(
  '@kamiazya/whiteboard-server-core/test-utils/tools'
)
const { FileVersionStore } = await import('./version-store.js')
const { createAutoVersionTrigger } = await import('./auto-version.js')
const { installAutoCheckpoint, uninstallAutoCheckpointForTests } = await import(
  './auto-checkpoint.js'
)
const { disposeAutoCompact } = await import('./auto-compact.js')
const { getDb } = await import('./db/index.js')
const { openWorkspaceDocIfStored } = await import('./workspace-doc-cache.js')
const { frontiersToBase64 } = await import('@kamiazya/whiteboard-history')
const { encodeFrontiers } = await import('loro-crdt')

const node = (i: number) => ({
  op: 'node.add' as const,
  node: {
    id: `n${i}`,
    type: 'text' as const,
    text: `note ${i}`,
    x: i * 100,
    y: 0,
    width: 80,
    height: 40,
  },
})

async function board(deps: ServerDeps, kind: 'spatial' | 'markdown' = 'spatial') {
  const created = await createWorkspaceEditTool(deps).execute({
    workspaceId: 'agent-history',
    createWorkspace: true,
    ops: [{ op: 'document.create', path: 'board', kind }],
  })
  const documentId = created.results[0]?.documentId
  if (documentId === undefined) throw new Error('document.create returned no id')
  return { workspaceId: created.workspaceId, documentId }
}

describe('what an agent write leaves in the history', () => {
  let deps: ServerDeps
  const events: Parameters<DocumentWritten>[0][] = []
  beforeEach(async () => {
    events.length = 0
    const real = await resolveTestServerDeps(tmp.dir)
    deps = {
      ...real,
      documentWritten: async (event) => {
        events.push(event)
        await real.documentWritten(event)
      },
    }
  })
  afterEach(async () => {
    uninstallAutoCheckpointForTests()
    await disposeAutoCompact()
  })

  it('a saved version records the nodes the stored document holds, the record frontier and the digest', async () => {
    const { workspaceId, documentId } = await board(deps)
    await createCanvasEditTool(deps).execute({
      workspaceId,
      documentId,
      mode: 'apply',
      ops: [
        node(0),
        node(1),
        node(2),
        { op: 'edge.add', edge: { id: 'e1', from: { node: 'n0' }, to: { node: 'n1' } } },
      ],
    })

    await createVersionSaveTool(deps).execute({
      workspaceId,
      documentIds: [documentId],
      label: 'three',
    })

    const [entry] = await new FileVersionStore().list(workspaceId, 'board')
    // Edges are not counted: a nodes-only count is never 0 for a non-empty scene.
    expect(entry?.elementCount).toBe(3)
    const [row] = await (await getDb(tmp.dir))
      .selectFrom('versions')
      .select(['frontiers', 'contentDigest', 'documentId'])
      .where('workspaceId', '=', workspaceId)
      .execute()
    const record = await openWorkspaceDocIfStored(workspaceId)
    expect(row?.documentId).toBe(documentId)
    expect(row?.frontiers).toBe(frontiersToBase64(encodeFrontiers(record?.frontiers() ?? [])))
    const placed = await deps.documentIndex.resolveDocumentById({ workspaceId, documentId })
    expect(row?.contentDigest).toBe(placed?.contentDigest)
    expect(row?.contentDigest).not.toBe('')
  })

  it('a saved version of a markdown document records no nodes', async () => {
    const { workspaceId, documentId } = await board(deps, 'markdown')
    await createVersionSaveTool(deps).execute({
      workspaceId,
      documentIds: [documentId],
      label: 'note',
    })
    const [entry] = await new FileVersionStore().list(workspaceId, 'board')
    expect(entry?.elementCount).toBe(0)
  })

  it('the observer is told the workspace, the document and where the index places it', async () => {
    const { workspaceId, documentId } = await board(deps)
    events.length = 0
    await createCanvasEditTool(deps).execute({
      workspaceId,
      documentId,
      mode: 'apply',
      ops: [node(0)],
    })
    expect(events.map(({ workspaceId: ws, documentId: id, path }) => ({ ws, id, path }))).toEqual([
      { ws: workspaceId, id: documentId, path: 'board' },
    ])
    // The seam hands over no open document: what the observer needs it reads from the keeper.
    expect(Object.keys(events[0] ?? {}).sort()).toEqual(['documentId', 'path', 'workspaceId'])
  })

  describe('the automatic checkpoint', () => {
    // The keeper's own rows would also silence a repeat, so this one answers
    // "no" and leaves the scheduler's memory of the frontier it saved at as the
    // only thing that can.
    const saves: string[] = []
    const store = {
      save: async (_workspaceId: string, path: string) => {
        saves.push(path)
        return { id: `v${saves.length}` }
      },
      isUnchangedSinceLastVersion: async () => false,
    }

    beforeEach(() => {
      saves.length = 0
    })

    it('is taken once per state: a write that changes nothing is not checkpointed again', async () => {
      const trigger = createAutoVersionTrigger(store as never, { quietMs: 60_000 })
      installAutoCheckpoint(trigger)
      const { workspaceId, documentId } = await board(deps)
      const edit = createCanvasEditTool(deps)

      await edit.execute({ workspaceId, documentId, mode: 'apply', ops: [node(0)] })
      await trigger.flush()
      expect(saves).toEqual(['board'])

      await edit.execute({
        workspaceId,
        documentId,
        mode: 'apply',
        ops: [{ op: 'node.patch', id: 'n0', patch: { text: 'note 0' } }],
      })
      await trigger.flush()
      expect(saves).toEqual(['board'])

      await edit.execute({ workspaceId, documentId, mode: 'apply', ops: [node(1)] })
      await trigger.flush()
      expect(saves).toEqual(['board', 'board'])
      trigger.stop()
    })
  })
})
