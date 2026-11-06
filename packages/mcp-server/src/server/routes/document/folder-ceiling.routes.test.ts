/**
 * Every daemon route that places a NEW document through the per-document save
 * refuses at the workspace's folder ceiling with the 413 `too_many_folders`
 * the workspace-record sync update answers, since placing a document creates
 * every folder its path names that the tree does not hold yet: a version
 * restored to a new path.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readWorkspaceNodes, WORKSPACE_TREE_KEY } from '@kamiazya/whiteboard-loro-adapter'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resolveTestServerDeps,
  testDocumentRouterOptions,
  withTempDataDir,
} from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-folder-ceiling-test-')

/** Written out rather than imported, so the test is not judged by the constant it judges. */
const CEILING = 4000
const WS = '01M8BBN7JS60N0ZAR13NP8SXBF'

let serverDeps: ServerDeps
beforeEach(async () => {
  serverDeps = await resolveTestServerDeps(tmp.dir)
  await serverDeps.documentIndex.createWorkspace({ workspaceId: WS })
})

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { clearDocCacheForTests } = await import('../../store/doc-cache.js')
const { saveDocument } = await import('../../store/document-store.js')
const { getWorkspaceDoc, saveWorkspaceDoc } = await import('../../store/workspace-doc-cache.js')
const { createDocumentRouter } = await import('../document.js')

beforeEach(async () => {
  await mkdir(join(tmp.dir, WS), { recursive: true })
  clearDocCacheForTests()
})
afterEach(() => {
  clearDocCacheForTests()
})

const foldersIn = (record: LoroDoc) =>
  readWorkspaceNodes(record).filter((node) => node.type === 'folder').length

async function storedFolders(): Promise<number> {
  return foldersIn(await getWorkspaceDoc(WS))
}

/** Fills the stored record up to `total` folders with raw root folder nodes, in one save. */
async function fillTo(total: number): Promise<void> {
  const record = await getWorkspaceDoc(WS)
  const tree = record.getTree(WORKSPACE_TREE_KEY)
  for (let i = foldersIn(record); i < total; i++) tree.createNode().data.set('segment', `f${i}`)
  record.commit()
  await saveWorkspaceDoc(WS, record)
}

function router() {
  return createDocumentRouter(testDocumentRouterOptions({ serverDeps }))
}

async function expectRefusedAtCeiling(res: Response, path: string): Promise<void> {
  expect(res.status).toBe(413)
  expect(((await res.json()) as { error: string }).error).toBe('too_many_folders')
  expect(await storedFolders()).toBe(CEILING)
  const listed = await serverDeps.documentIndex.listDocuments({ workspaceId: WS })
  expect(listed.some((entry) => entry.path === path)).toBe(false)
}

describe('placing a new document at the folder ceiling', () => {
  it('refuses a version restored to a new path under a missing folder', async () => {
    await saveDocument(WS, 'canvas-a', new LoroDoc())
    const app = router()
    const saved = await app.request(`/api/workspaces/${WS}/documents/canvas-a/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })
    const { version } = (await saved.json()) as { version: { id: string } }
    await fillTo(CEILING)

    const res = await app.request(
      `/api/workspaces/${WS}/documents/canvas-a/versions/${version.id}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPath: 'deep/er/canvas-new' }),
      },
    )

    await expectRefusedAtCeiling(res, 'deep/er/canvas-new')
  })
})
