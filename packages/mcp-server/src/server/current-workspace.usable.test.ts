/**
 * The workspace a fresh daemon bootstraps is a workspace like any other: the
 * list names it, so every route that addresses it has to accept it. It used
 * to be listed from a registry row alone, with no stored record behind it,
 * and the document index refused it as not found — the first screen after
 * connecting a browser to a new daemon, and its "Create a canvas" button.
 */
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from './routes/_test-helpers.js'

const tmp = withTempDataDir('whiteboard-bootstrap-usable-')

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { clearWorkspaceIdCacheForTests, ensureWorkspaceId } = await import('./current-workspace.js')
const { getDb } = await import('./store/db/index.js')
const { prepareDataDir } = await import('./store/db/prepare.js')
const { upsertWorkspaceRow } = await import('./store/db/upsert-workspace.js')
const { createContainer, resolveServerDeps } = await import('../di/container.js')
const { createSelfHostStoreLocalModule } = await import('../di/store-local.module.js')

afterEach(() => clearWorkspaceIdCacheForTests())

async function documentIndex() {
  const db = await getDb(tmp.dir)
  return resolveServerDeps(createContainer(createSelfHostStoreLocalModule(db, tmp.dir)))
    .documentIndex
}

describe('the bootstrapped workspace', () => {
  it('takes its first document, as the workspace list promises', async () => {
    const workspaceId = await ensureWorkspaceId(tmp.dir)
    const index = await documentIndex()
    expect((await index.listWorkspaces()).map((w) => w.workspaceId)).toContain(workspaceId)

    const created = await index.createDocument({ workspaceId, path: 'first', kind: 'markdown' })
    expect(created.path).toBe('first')
    expect((await index.listDocuments({ workspaceId })).map((d) => d.path)).toEqual(['first'])
  })

  // A daemon that ran the old bootstrap holds the registry row and no record;
  // the next boot has to heal it rather than leave it listed and unusable.
  it('is repaired on the next boot when an earlier one left only its registry row', async () => {
    await prepareDataDir(tmp.dir)
    const db = await getDb(tmp.dir)
    const workspaceId = generateDocumentId()
    await db
      .insertInto('runtime')
      .values({ key: 'currentWorkspaceId', value: workspaceId, updatedAt: Date.now() })
      .execute()
    await upsertWorkspaceRow(db, workspaceId)

    await expect(ensureWorkspaceId(tmp.dir)).resolves.toBe(workspaceId)
    const index = await documentIndex()
    await expect(
      index.createDocument({ workspaceId, path: 'first', kind: 'markdown' }),
    ).resolves.toMatchObject({ path: 'first' })
  })
})
