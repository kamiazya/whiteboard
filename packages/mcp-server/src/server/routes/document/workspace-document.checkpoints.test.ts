/**
 * What an update to the workspace record leaves in each edited document's
 * history: the documents the update wrote get an automatic checkpoint, the
 * ones it left alone do not, and an update that changes nothing in a document
 * adds nothing to it.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resolveTestServerDeps,
  testDocumentRouterOptions,
  withTempDataDir,
} from '../_test-helpers.js'

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const tmp = withTempDataDir('whiteboard-update-checkpoints-')
const WS = '01M8BBN7JS60N0ZAR13NP8SXBF'
const A = '01BRWAAAAAAAAAAAAAAAAAAAA1'
const B = '01BRWAAAAAAAAAAAAAAAAAAAA2'

let serverDeps: ServerDeps
beforeEach(async () => {
  serverDeps = await resolveTestServerDeps(tmp.dir)
  await serverDeps.documentIndex.createWorkspace({ workspaceId: WS })
})

const { createDocumentRouter } = await import('../document.js')
await import('../../sync-audience.js')

async function harness() {
  let trigger: { flush(): Promise<void> } | undefined
  const app = createDocumentRouter(
    testDocumentRouterOptions({
      serverDeps,
      autoVersionQuietMs: 0,
      onAutoVersionTrigger: (made) => {
        trigger = made
      },
    }),
  )
  const base = `/api/w/${WS}/workspace-document`
  /** Edits the record on a replica of it and sends the update. */
  const send = async (edit: (replica: LoroDoc) => void) => {
    const snapshot = await app.request(`${base}/snapshot`)
    const replica = LoroDoc.fromSnapshot(new Uint8Array(await snapshot.arrayBuffer()))
    const from = replica.oplogVersion()
    edit(replica)
    replica.commit()
    const res = await app.request(`${base}/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: replica.export({ mode: 'update', from }) as Uint8Array<ArrayBuffer>,
    })
    expect(res.status).toBe(200)
    // The checkpoints are signalled after the response, one document at a time;
    // what each test waits for is the row that signal lands.
    await vi.waitFor(() => expect(trigger).toBeDefined())
  }
  const flush = () => trigger?.flush()
  const rows = async (path: string) => (await serverDeps.versions.list(WS, path)).length
  return { send, rows, flush }
}

describe('an update to the workspace record', () => {
  it('checkpoints each document it wrote, leaves the ones it did not, and adds nothing for a repeat', async () => {
    const { send, rows, flush } = await harness()
    await send((replica) => {
      createWorkspaceDocumentAtPath(replica, { path: 'a', documentId: A, kind: 'markdown' })
      createWorkspaceDocumentAtPath(replica, { path: 'b', documentId: B, kind: 'markdown' })
      writeMarkdownBody(documentContainers(replica, A), 'a one')
      writeMarkdownBody(documentContainers(replica, B), 'b one')
    })
    await vi.waitFor(async () => {
      expect([await rows('a'), await rows('b')]).toEqual([1, 1])
    })

    await send((replica) => writeMarkdownBody(documentContainers(replica, A), 'a two'))
    await vi.waitFor(async () => expect(await rows('a')).toBe(2))
    expect(await rows('b')).toBe(1)

    // The same content again is held by the newest row: nothing new.
    await send((replica) => writeMarkdownBody(documentContainers(replica, A), 'a two'))
    await flush()
    expect([await rows('a'), await rows('b')]).toEqual([2, 1])
  })
})
