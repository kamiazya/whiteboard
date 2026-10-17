/**
 * Every daemon route that places a NEW document refuses at the workspace's
 * document ceiling with the 413 `too_many_documents` the workspace-record
 * sync update answers: the per-document update's lazy create, a duplicate,
 * a restore from the trash, and a version restored to a new path. An update to a document that already exists
 * is not a new document and is still taken.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { documentDuplicateApiUrl } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { readWorkspaceDocuments, WORKSPACE_TREE_KEY } from '@kamiazya/whiteboard-loro-adapter'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resolveTestServerDeps,
  testDocumentRouterOptions,
  withTempDataDir,
} from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-document-ceiling-test-')

/** Written out rather than imported, so the test is not judged by the constant it judges. */
const CEILING = 2000
const WS = 'session1'

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

/** `n` in the ULID alphabet, so a seeded id is canonical. */
function crockford(n: number): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let out = ''
  let rest = n
  do {
    out = alphabet[rest % 32] + out
    rest = Math.floor(rest / 32)
  } while (rest > 0)
  return out
}

/** Fills the stored record up to `total` documents with raw tree nodes, in one save. */
async function fillTo(total: number): Promise<void> {
  const record = await getWorkspaceDoc(WS)
  const tree = record.getTree(WORKSPACE_TREE_KEY)
  for (let i = readWorkspaceDocuments(record).length; i < total; i++) {
    const node = tree.createNode()
    node.data.set('documentId', `01BRWC${crockford(i).padStart(20, '0')}`)
    node.data.set('segment', `filler-${i}`)
    node.data.set('kind', 'markdown')
    node.data.set('createdAt', 1_000)
    node.data.set('updatedAt', 1_000)
  }
  record.commit()
  await saveWorkspaceDoc(WS, record)
}

function elementUpdate(id: string): Uint8Array<ArrayBuffer> {
  const client = new LoroDoc()
  const from = client.version()
  client.getMovableList('elements').insertContainer(0, new LoroMap()).set('id', id)
  client.commit()
  return client.export({ mode: 'update', from }) as Uint8Array<ArrayBuffer>
}

function post(url: string, body?: Uint8Array<ArrayBuffer>) {
  const app = createDocumentRouter(testDocumentRouterOptions({ serverDeps }))
  return app.request(url, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/octet-stream' }, body }),
  })
}

const postUpdate = (path: string, body: Uint8Array<ArrayBuffer>) =>
  post(`/api/w/${WS}/document/${path}/update`, body)

async function expectRefusedAtCeiling(res: Response): Promise<void> {
  expect(res.status).toBe(413)
  expect(((await res.json()) as { error: string }).error).toBe('too_many_documents')
  expect(await serverDeps.documentIndex.listDocuments({ workspaceId: WS })).toHaveLength(CEILING)
}

describe('POST …/document/:path/update at the document ceiling', () => {
  it('refuses to create a document at a new path, and the workspace keeps what it held', async () => {
    await fillTo(CEILING)

    const res = await postUpdate('fresh', elementUpdate('e1'))

    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: string }).error).toBe('too_many_documents')
    const listed = await serverDeps.documentIndex.listDocuments({ workspaceId: WS })
    expect(listed).toHaveLength(CEILING)
    expect(listed.some((entry) => entry.path === 'fresh')).toBe(false)
  })

  it('still takes an update to a document the workspace already holds', async () => {
    await saveDocument(WS, 'canvas-a', new LoroDoc())
    await fillTo(CEILING)

    const res = await postUpdate('canvas-a', elementUpdate('e2'))

    expect(res.status).toBe(200)
    expect(await serverDeps.documentIndex.listDocuments({ workspaceId: WS })).toHaveLength(CEILING)
  })

  it('refuses a duplicate', async () => {
    await saveDocument(WS, 'source', new LoroDoc())
    await fillTo(CEILING)

    await expectRefusedAtCeiling(await post(documentDuplicateApiUrl(WS, 'source')))
  })

  it('refuses a restore from the trash', async () => {
    await saveDocument(WS, 'victim', new LoroDoc())
    const victim = await serverDeps.documentIndex.resolveDocument({
      workspaceId: WS,
      path: 'victim',
    })
    await serverDeps.documentIndex.deleteDocument({ workspaceId: WS, path: 'victim' })
    await fillTo(CEILING)

    await expectRefusedAtCeiling(
      await post(`/api/workspaces/${WS}/trash/${victim?.documentId}/restore`),
    )
  })

  it('refuses a version restored to a new path', async () => {
    await saveDocument(WS, 'canvas-a', new LoroDoc())
    const app = createDocumentRouter(testDocumentRouterOptions({ serverDeps }))
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
        body: JSON.stringify({ targetPath: 'canvas-new' }),
      },
    )

    await expectRefusedAtCeiling(res)
  })
})
