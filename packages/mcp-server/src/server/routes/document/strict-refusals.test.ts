import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { apiErrorReason, type ServerDeps } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resolveTestServerDeps,
  testDocumentRouterOptions,
  withTempDataDir,
} from '../_test-helpers.js'

const tmp = withTempDataDir('whiteboard-strict-refusals-test-')

let serverDeps: ServerDeps
beforeEach(async () => {
  serverDeps = await resolveTestServerDeps(tmp.dir)
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
const { saveDocument, _clearWorkspaceDocCacheForTests } = await import(
  '../../store/document-store.js'
)
const { createDocumentRouter } = await import('../document.js')

beforeEach(async () => {
  await mkdir(join(tmp.dir, 'session1'), { recursive: true })
  clearDocCacheForTests()
  _clearWorkspaceDocCacheForTests()
  await saveDocument('session1', 'canvas-a', new LoroDoc(), { kind: 'spatial' })
})
afterEach(() => {
  clearDocCacheForTests()
})

// Request bodies are strict so that a caller learns a field it sent did not
// take effect. The refusal is only worth that if it names the field: a newer
// page posting a field this daemon does not know used to be told that a field
// it HAD sent was missing, which sends the person to the wrong place.
const DOC = '/api/workspaces/session1/documents/canvas-a'

const routes: readonly [name: string, method: string, path: string, valid: object][] = [
  ['create a workspace', 'POST', '/api/workspaces', { displayName: 'Y' }],
  ['rename a workspace', 'PATCH', '/api/workspaces/session1', { displayName: 'X' }],
  ['set a workspace name', 'PUT', '/api/workspaces/session1/name', { name: 'N' }],
  ['set a document name', 'PUT', `${DOC}/name`, { name: 'N' }],
  ['pin a document', 'PUT', `${DOC}/pin`, { pinned: true }],
  ['save a version', 'POST', `${DOC}/versions`, { label: 'l' }],
  ['move a document', 'PUT', `${DOC}/path`, { path: 'canvas-a2' }],
  ['restore a version', 'POST', `${DOC}/versions/v1/restore`, { overwrite: true }],
]

describe('a strict request refuses with the key it did not recognise', () => {
  it('walks a real population of routes', () => {
    expect(routes.length).toBeGreaterThanOrEqual(8)
  })

  it.each(routes)('%s', async (_name, method, path, valid) => {
    const app = createDocumentRouter(
      testDocumentRouterOptions({
        serverDeps,
        autoVersionQuietMs: 60_000,
      }),
    )

    const res = await app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...valid, zzz: 1 }),
    })

    expect(res.status).toBe(400)
    expect(apiErrorReason(await res.json())).toContain('zzz')
  })

  it('names the object a nested unrecognised key sits in', async () => {
    const app = createDocumentRouter(
      testDocumentRouterOptions({
        serverDeps,
        autoVersionQuietMs: 60_000,
      }),
    )

    const res = await app.request(`${DOC}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'l', operator: { kind: 'human', zzz: 1 } }),
    })

    expect(res.status).toBe(400)
    expect(apiErrorReason(await res.json())).toBe('operator: Unrecognized key: "zzz"')
  })
})
