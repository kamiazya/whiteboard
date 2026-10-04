/**
 * Every route that caps its request body answers an oversized one the same
 * way — 413 `payload_too_large`, with a message naming what was too big and
 * the limit — and each names its own noun and limit.
 *
 * `body-limit.test.ts` pins the helper; this is the per-route half, with the
 * exact body, so a route that swaps its limit or its noun, or goes back to
 * building the body by hand, fails by name. The suites beside each route pin
 * only the code.
 */
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resolveTestServerDeps,
  testDocumentRouterOptions,
  testStoreScope,
  withTempDataDir,
} from './_test-helpers.js'

const tmp = withTempDataDir('whiteboard-payload-too-large-')

let serverDeps: ServerDeps
beforeEach(async () => {
  serverDeps = await resolveTestServerDeps(tmp.dir)
  await serverDeps.documentIndex.createWorkspace({ workspaceId: 's1' })
})

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createDocumentRouter } = await import('./document.js')
const { createExportRouter } = await import('./export.js')
const { createFilesRouter } = await import('./files.js')

const MIB = 1024 * 1024

type Build = () => { request: (path: string, init: RequestInit) => Response | Promise<Response> }

const CASES: readonly {
  readonly route: string
  readonly method: string
  readonly path: string
  readonly build: Build
  readonly limit: number
  readonly noun: string
}[] = [
  {
    route: 'file upload',
    method: 'PUT',
    path: '/api/w/s1/document/canvas-a/file/img1',
    build: () => createFilesRouter({ scope: testStoreScope(tmp.dir) }),
    limit: 16 * MIB,
    noun: 'Upload',
  },
  {
    route: 'PNG export',
    method: 'POST',
    path: '/api/w/s1/document/canvas-a/export',
    build: () =>
      createExportRouter({
        liveDocuments: { exists: async () => true },
        scope: testStoreScope(tmp.dir),
      }),
    limit: MIB,
    noun: 'Request body',
  },
  {
    route: 'SVG export',
    method: 'POST',
    path: '/api/w/s1/document/canvas-a/export-svg',
    build: () => createDocumentRouter(testDocumentRouterOptions({ serverDeps })),
    limit: MIB,
    noun: 'Request body',
  },
  {
    route: 'live document update',
    method: 'POST',
    path: '/api/w/s1/document/canvas-a/update',
    build: () => createDocumentRouter(testDocumentRouterOptions({ serverDeps })),
    limit: 16 * MIB,
    noun: 'Update',
  },
  {
    route: 'workspace document update',
    method: 'POST',
    path: '/api/w/s1/workspace-document/update',
    build: () => createDocumentRouter(testDocumentRouterOptions({ serverDeps })),
    limit: 16 * MIB,
    noun: 'Update',
  },
  {
    route: 'workspace promotion',
    method: 'POST',
    path: '/api/w/s1/workspace-document/promote',
    build: () => createDocumentRouter(testDocumentRouterOptions({ serverDeps })),
    limit: 24 * MIB,
    noun: 'Promotion',
  },
]

describe('an oversized request body', () => {
  for (const { route, method, path, build, limit, noun } of CASES) {
    it(`is 413 payload_too_large on the ${route} route`, async () => {
      const res = await build().request(path, {
        method,
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(limit + 1),
      })
      expect(res.status).toBe(413)
      expect(await res.json()).toEqual({
        error: 'payload_too_large',
        message: `${noun} exceeds ${limit} bytes limit.`,
      })
    })
  }
})
