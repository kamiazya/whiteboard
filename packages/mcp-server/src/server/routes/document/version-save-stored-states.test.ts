// What saving a version does for a document in each stored state, through the tool and the route.
// The outcomes were recorded on the code that loaded the document first, so a save that reads the
// stored record instead stays the same answer: a retired shape saves, a record that cannot be
// opened is refused as corrupt, a document the index does not hold is not found.
import { documentContainers, writeMarkdownBody } from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { LoroDoc, LoroMovableList } from 'loro-crdt'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestDocument,
  documentIdAt,
  resolveTestServerDeps,
  seedWorkspaceRow,
  testDocumentRouterOptions,
  withTempDataDir,
} from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-diff-')
vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))
const { clearDocCacheForTests } = await import('../../store/doc-cache.js')
const { saveDocument, _clearWorkspaceDocCacheForTests } = await import(
  '../../store/document-store.js'
)
const { getWorkspaceDoc, saveWorkspaceDoc } = await import('../../store/workspace-doc-cache.js')
const { createDocumentRouter } = await import('../document.js')
const { getDb } = await import('../../store/db/index.js')
const { createVersionSaveTool } = await import('@kamiazya/whiteboard-server-core/test-utils/tools')
const { makeSpatialDoc } = await import('../../../shared/test-utils/spatial-doc.js')

const WS = '01M8BBN7JS60N0ZAR13NP8SXBF'

type State =
  | 'a-canvas'
  | 'b-note'
  | 'c1-elements'
  | 'c2-xwhiteboard'
  | 'd-comments'
  | 'e-corrupt'
  | 'f-no-snapshot'
  | 'g-no-index'
/** A healthy canvas of three nodes, or a note. */
async function seedContent(state: State, path: string): Promise<void> {
  if (state === 'b-note') {
    const d = new LoroDoc()
    writeMarkdownBody(d, 'hello')
    d.commit()
    await saveDocument(WS, path, d, { kind: 'markdown', overwrite: true })
    return
  }
  const nodes = [1, 2, 3].map((i) =>
    textNode({ id: `n${i}`, text: 'a', x: 0, y: 0, width: 10, height: 10 }),
  )
  const edges = [{ id: 'e1', from: { node: 'n1' }, to: { node: 'n2' } }]
  await saveDocument(WS, path, makeSpatialDoc({ nodes, edges }), {
    kind: 'spatial',
    overwrite: true,
  })
}

/** Writes a stored shape this build no longer reads straight into the record. */
function plantRetired(rec: LoroDoc, id: string, state: State): void {
  if (state === 'c1-elements') {
    const node = rec
      .getTree('tree')
      .getNodes()
      .find((n) => n.data.get('documentId') === id)
    node?.data.setContainer('elements', new LoroMovableList()).push({ id: 'old' })
  }
  const content = documentContainers(rec, id)
  if (state === 'c2-xwhiteboard') {
    content.getMap('nodes').set('old', { id: 'old', 'x-whiteboard': { a: 1 } })
  }
  if (state === 'd-comments') content.getMap('comments').set('c1', { id: 'c1' })
  rec.commit()
}

async function corruptRecord(): Promise<void> {
  const db = await getDb(tmp.dir)
  await db
    .updateTable('documentSnapshotChunks')
    .set({ bytes: new Uint8Array([222, 173, 190, 239, 0, 255]) as never })
    .where('docKey', 'like', '%workspace-tree%')
    .execute()
  await db.deleteFrom('documentDeltas').where('docKey', 'like', '%workspace-tree%').execute()
}

async function plant(deps: ServerDeps, state: State): Promise<{ id: string; path: string }> {
  const path = 'doc'
  await seedWorkspaceRow(tmp.dir, WS)
  if (state === 'g-no-index') {
    await createTestDocument(deps, { workspaceId: WS, path: 'other' })
    return { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', path: 'nowhere' }
  }
  if (state === 'f-no-snapshot') {
    await deps.documentIndex.createWorkspace({ workspaceId: WS }).catch(() => undefined)
    const e = await deps.documentIndex.createDocument({ workspaceId: WS, path, kind: 'spatial' })
    return { id: e.documentId, path }
  }
  await seedContent(state, path)
  const id = await documentIdAt(deps, WS, path)
  if (/^[cd]/.test(state)) {
    const rec = await getWorkspaceDoc(WS)
    plantRetired(rec, id, state)
    await saveWorkspaceDoc(WS, rec)
  }
  if (state === 'e-corrupt') await corruptRecord()
  clearDocCacheForTests()
  _clearWorkspaceDocCacheForTests()
  return { id, path }
}

let deps: ServerDeps
beforeEach(async () => {
  deps = await resolveTestServerDeps(tmp.dir)
})

const rowsOf = async () =>
  (
    await (
      await getDb(tmp.dir)
    )
      .selectFrom('versions')
      .select(['elementCount', 'contentDigest'])
      .execute()
  ).map((row) => row.elementCount)

/** Saved states: what the row counts. A retired shape and the retired comment plane are stored as they are, so they save. */
const SAVES: readonly (readonly [State, number])[] = [
  ['a-canvas', 3],
  ['b-note', 0],
  ['c1-elements', 0],
  ['c2-xwhiteboard', 0],
  ['d-comments', 3],
  ['f-no-snapshot', 0],
]

describe('saving a version of a document in each stored state', () => {
  for (const [state, count] of SAVES) {
    it(`wb_version_save records ${state} with ${count} nodes`, async () => {
      const { id } = await plant(deps, state)
      const saved = await createVersionSaveTool(deps).execute({
        workspaceId: WS,
        documentIds: [id],
        label: 'x',
      } as never)
      expect(saved.saved[0]?.version.label).toBe('x')
      expect(await rowsOf()).toEqual([count])
    })
    it(`POST /versions records ${state} with ${count} nodes`, async () => {
      const { id } = await plant(deps, state)
      const app = createDocumentRouter(
        testDocumentRouterOptions({ serverDeps: deps, autoVersionQuietMs: 60_000 }),
      )
      const res = await app.request(`/api/workspaces/${WS}/documents/${id}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'x' }),
      })
      expect(res.status).toBe(200)
      expect(await rowsOf()).toEqual([count])
    })
  }

  it('wb_version_save refuses a record that cannot be opened, with its corruption code, and records nothing', async () => {
    const { id } = await plant(deps, 'e-corrupt')
    await expect(
      createVersionSaveTool(deps).execute({
        workspaceId: WS,
        documentIds: [id],
        label: 'x',
      } as never),
    ).rejects.toMatchObject({ name: 'CorruptStoredDataError', code: 'corrupt_stored_data' })
    expect(await rowsOf()).toEqual([])
  })

  it('POST /versions answers 500 corrupt_stored_data for a record that cannot be opened', async () => {
    const { id } = await plant(deps, 'e-corrupt')
    const app = createDocumentRouter(
      testDocumentRouterOptions({ serverDeps: deps, autoVersionQuietMs: 60_000 }),
    )
    const res = await app.request(`/api/workspaces/${WS}/documents/${id}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: 'corrupt_stored_data' })
  })

  it('refuses a document the index does not hold: the tool as not found, the route as 404', async () => {
    const { id } = await plant(deps, 'g-no-index')
    await expect(
      createVersionSaveTool(deps).execute({
        workspaceId: WS,
        documentIds: [id],
        label: 'x',
      } as never),
    ).rejects.toMatchObject({ name: 'WorkspaceDocumentNotFoundError' })
    const app = createDocumentRouter(
      testDocumentRouterOptions({ serverDeps: deps, autoVersionQuietMs: 60_000 }),
    )
    const res = await app.request(`/api/workspaces/${WS}/documents/${id}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'not_found' })
    expect(await rowsOf()).toEqual([])
  })
})
