/**
 * The two Content-Type defaults of the file route, which a test that always
 * sends or stores a known type never reaches: an upload with no header, and a
 * stored file whose extension is not one the route writes.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { StoreScope } from '../store/store-scope.js'
import {
  resolvingDocumentIds,
  testFilesRouterOptions,
  testStoreScope,
  withTempDataDir,
} from './_test-helpers.js'

const tmp = withTempDataDir('whiteboard-files-content-type-')

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createFilesRouter } = await import('./files.js')

const BOARD = '01HZX3QK8M2N5P7R9T1V3W5Y7A'

// The daemon resolves the document id once ahead of its routers; the index here
// holds one document, at `board`.
function filesApp(scope: StoreScope) {
  const app = new Hono()
  resolvingDocumentIds(app, { [BOARD]: { path: 'board' } })
  app.route('/', createFilesRouter(testFilesRouterOptions(scope)))
  return app
}

const route = (fileId: string) => `/api/workspaces/ws-ct/documents/${BOARD}/files/${fileId}`

describe('the file route when the type is not stated', () => {
  it('stores an upload with no Content-Type as a PNG', async () => {
    const app = filesApp(testStoreScope(tmp.dir))

    const stored = await app.request(route('untyped1'), {
      method: 'PUT',
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    })
    expect(stored.status).toBe(204)

    const read = await app.request(route('untyped1'))
    expect(read.status).toBe(200)
    expect(read.headers.get('Content-Type')).toBe('image/png')
  })

  it('serves a stored file with an extension the route never writes as opaque bytes', async () => {
    const scope = testStoreScope(tmp.dir)
    const dir = scope.layout.workspaceFilesDir('ws-ct')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'foreign1.bin'), new Uint8Array([1, 2, 3]))

    const read = await filesApp(scope).request(route('foreign1'))
    expect(read.status).toBe(200)
    expect(read.headers.get('Content-Type')).toBe('application/octet-stream')
  })
})
