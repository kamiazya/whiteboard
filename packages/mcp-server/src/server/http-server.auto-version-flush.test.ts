import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { socketFetch, testSocketPath } from '../shared/test-utils/socket-fetch.js'

/**
 * A checkpoint is taken once a document has been QUIET for five minutes, so
 * the state a person leaves behind is exactly the state that is still pending
 * when the daemon goes away. Shutting down without flushing loses precisely
 * the checkpoint the trailing debounce exists to take.
 *
 * The whole chain rather than the seam: the trigger is created inside the
 * document router, and what has to be true is that closing the SERVER reaches
 * it.
 */
let tmpRoot: string

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return tmpRoot
  },
  getDataDir: () => tmpRoot,
  get DIST_WEB_APP_DIR() {
    return join(tmpRoot, 'dist-web-app')
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { startHttpServer } = await import('./http-server.js')
const { saveDocument, _clearWorkspaceDocCacheForTests } = await import('./store/document-store.js')
const { clearDocCacheForTests } = await import('./store/doc-cache.js')
const { FileVersionStore } = await import('./store/version-store.js')

describe('startHttpServer takes the pending checkpoint on the way out', () => {
  let running: Awaited<ReturnType<typeof startHttpServer>> | undefined

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'whiteboard-autoversion-flush-'))
    await mkdir(join(tmpRoot, '01M8BBN7JS60N0ZAR13NP8SXBF'), { recursive: true })
    clearDocCacheForTests()
    _clearWorkspaceDocCacheForTests()
    await saveDocument('01M8BBN7JS60N0ZAR13NP8SXBF', 'canvas-a', new LoroDoc(), { kind: 'spatial' })
  })

  afterEach(async () => {
    await running?.close()
    running = undefined
    clearDocCacheForTests()
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('writes the checkpoint an edit left pending when close() runs', async () => {
    const clientDoc = new LoroDoc()
    const from = clientDoc.version()
    const element = clientDoc.getMovableList('elements').insertContainer(0, new LoroMap())
    element.set('id', 'e1')
    clientDoc.commit()
    const update = clientDoc.export({ mode: 'update', from }) as Uint8Array<ArrayBuffer>

    const socketPath = testSocketPath()
    running = await startHttpServer({ socketPath })

    const res = await socketFetch(socketPath)(
      '/api/w/01M8BBN7JS60N0ZAR13NP8SXBF/document/canvas-a/update',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: update,
      },
    )
    expect(res.status).toBe(200)

    const store = new FileVersionStore()
    // Nothing yet — the pause has not elapsed, which is what makes the flush
    // the only thing that can produce the row below.
    expect(await store.list('01M8BBN7JS60N0ZAR13NP8SXBF', 'canvas-a')).toEqual([])

    await running.close()
    running = undefined

    const versions = await store.list('01M8BBN7JS60N0ZAR13NP8SXBF', 'canvas-a')
    expect(versions.length).toBe(1)
    expect(versions[0]?.auto).toBe(true)
  })
})
