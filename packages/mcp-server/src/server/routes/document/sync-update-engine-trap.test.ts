/**
 * The editor's sync writes after the CRDT engine traps on one of them.
 *
 * A trap leaves the cached `LoroDoc` holding a lock it never released, so
 * every later call on that instance traps too. Kept cached, one oversize
 * write would leave the workspace answering 500 until the daemon restarts,
 * after a 400 that blamed the client's bytes. These run the real router over
 * a real store and poison the cached instance the way a trap does: the write
 * that trapped answers `document_engine_trap`, and the next request is served
 * by a fresh instance.
 */
import {
  createWorkspaceDocumentAtPath,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { testDocumentRouterOptions, withTempDataDir } from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-sync-engine-trap-')

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { resolveTestServerDeps, seedWorkspaceRow } = await import('../_test-helpers.js')
const { createDocumentRouter } = await import('../document.js')
// Pre-load ws.js, mirroring the other route tests' documented cycle
// workaround for document.ts's dynamic import.
await import('../../sync-audience.js')

const WS = 'trap-ws'

afterEach(() => {
  vi.restoreAllMocks()
})

/** What loro-crdt's WASM throws when a Rust panic aborts a call. */
function poison(doc: LoroDoc): void {
  vi.spyOn(doc, 'import').mockImplementation(() => {
    throw Object.assign(new Error('unreachable'), { name: 'RuntimeError' })
  })
}

function workspaceRecord(path: string, mode: 'update' | 'snapshot'): Uint8Array<ArrayBuffer> {
  const doc = new LoroDoc()
  const vv0 = doc.version()
  createWorkspaceDocumentAtPath(doc, { path, documentId: generateDocumentId(), kind: 'spatial' })
  doc.commit()
  return (
    mode === 'update' ? doc.export({ mode, from: vv0 }) : doc.export({ mode })
  ) as Uint8Array<ArrayBuffer>
}

function documentUpdate(nodeId: string): Uint8Array<ArrayBuffer> {
  const doc = new LoroDoc()
  const vv0 = doc.version()
  writeSpatialCanvas(doc, {
    nodes: [textNode({ id: nodeId, text: nodeId, x: 0, y: 0, width: 10, height: 10 })],
    edges: [],
  })
  return doc.export({ mode: 'update', from: vv0 }) as Uint8Array<ArrayBuffer>
}

async function setup() {
  await seedWorkspaceRow(tmp.dir, WS)
  const deps = await resolveTestServerDeps(tmp.dir)
  const app = createDocumentRouter(
    testDocumentRouterOptions({ serverDeps: deps, autoVersionQuietMs: 60_000 }),
  )
  const post = (path: string, body: Uint8Array<ArrayBuffer> | string, json = false) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': json ? 'application/json' : 'application/octet-stream' },
      body,
    })
  return { deps, app, post }
}

describe('a sync write the CRDT engine traps on', () => {
  it('workspace-document update answers document_engine_trap and the next request is served', async () => {
    const { deps, app, post } = await setup()
    poison(await deps.workspaceDocuments.get(WS))

    const trapped = await post(
      `/api/w/${WS}/workspace-document/update`,
      workspaceRecord('a', 'update'),
    )
    expect(trapped.status).toBe(500)
    expect(await trapped.json()).toMatchObject({ error: 'document_engine_trap' })

    expect((await app.request(`/api/w/${WS}/workspace-document/snapshot`)).status).toBe(200)
    const next = await post(
      `/api/w/${WS}/workspace-document/update`,
      workspaceRecord('b', 'update'),
    )
    expect(next.status).toBe(200)
  })

  it('promote answers document_engine_trap and the next promote lands', async () => {
    const { deps, post } = await setup()
    poison(await deps.workspaceDocuments.get(WS))
    const promote = (path: string) =>
      post(
        `/api/w/${WS}/workspace-document/promote`,
        JSON.stringify({
          snapshot: Buffer.from(workspaceRecord(path, 'snapshot')).toString('base64url'),
        }),
        true,
      )

    const trapped = await promote('a')
    expect(trapped.status).toBe(500)
    expect(await trapped.json()).toMatchObject({ error: 'document_engine_trap' })

    expect((await promote('b')).status).toBe(200)
  })

  it('per-document update answers document_engine_trap and the next request is served', async () => {
    const { deps, app, post } = await setup()
    const url = `/api/w/${WS}/document/canvas-a`
    expect((await post(`${url}/update`, documentUpdate('n1'))).status).toBe(200)
    poison(await deps.liveDocuments.get(WS, 'canvas-a'))

    const trapped = await post(`${url}/update`, documentUpdate('n2'))
    expect(trapped.status).toBe(500)
    expect(await trapped.json()).toMatchObject({ error: 'document_engine_trap' })

    expect((await app.request(`${url}/snapshot`)).status).toBe(200)
    expect((await post(`${url}/update`, documentUpdate('n3'))).status).toBe(200)
  })
})
