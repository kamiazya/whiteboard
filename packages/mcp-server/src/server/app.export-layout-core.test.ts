/**
 * `createApp` hands both file exports the deps' layout core factory, so
 * `/export` and `/export-svg` lay a board out through the core that lays out
 * `wb_scene_render` (ADR-0054 step 7). The routers take it as an option; a
 * root that forgot to pass it would lay every export out in TypeScript, and
 * the drawing would be identical either way — so only asking says.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LayoutCore } from '@kamiazya/whiteboard-canvas-render'
import { writeSpatialNode } from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { wbDocumentCreate } from '@kamiazya/whiteboard-server-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bootSelfHostDeps } from '../di/boot-self-host-deps.js'
import { resetDataDirForTests, setDataDirForTests } from '../shared/data-dir-secure.js'
import { PACKAGE_VERSION } from '../shared/package-version.js'
import { createApp } from './app.js'
import { documentIdAt, documentOf } from './routes/_test-helpers.js'
import { disposeAutoCompact, uninstallAutoCompact } from './store/auto-compact.js'
import { clearDbCacheForTests, closeDb } from './store/db/index.js'
import { clearDocCacheForTests } from './store/doc-cache.js'
import { _clearWorkspaceDocCacheForTests } from './store/workspace-doc-cache.js'

const WS = '01ZVM89A4A1V9FS03Z9J64KEK2'

let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'wb-export-core-'))
  setDataDirForTests(dataDir)
})

afterEach(async () => {
  uninstallAutoCompact()
  await disposeAutoCompact()
  clearDocCacheForTests()
  _clearWorkspaceDocCacheForTests()
  await closeDb(dataDir)
  clearDbCacheForTests()
  resetDataDirForTests()
  await rm(dataDir, { recursive: true, force: true })
})

async function appAskingForTheCore() {
  const boot = await bootSelfHostDeps(dataDir)
  await boot.serverDeps.documentIndex.createWorkspace({ workspaceId: WS })
  await wbDocumentCreate(boot.serverDeps, { workspaceId: WS, path: 'board', kind: 'spatial' })
  const doc = await documentOf(boot.serverDeps, WS, 'board')
  writeSpatialNode(doc, textNode({ id: 'n1', x: 0, y: 0, width: 120, height: 40, text: 'hi' }))
  await boot.serverDeps.liveDocuments.save(WS, 'board', doc, { overwrite: true })
  const real = boot.serverDeps.layoutCore
  if (real === undefined) throw new Error('the booted deps carry no layout core')
  const layoutCore = vi.fn((): Promise<LayoutCore> => real())
  const app = createApp({
    authMode: 'local-daemon',
    serverDeps: { ...boot.serverDeps, layoutCore },
    dataLayout: boot.dataLayout,
    touch: () => {},
    getStatus: () => ({
      ok: true,
      pid: 1,
      socketPath: '/run/wb.sock',
      version: PACKAGE_VERSION,
      startedAt: '2026-04-23T00:00:00.000Z',
      uptimeMs: 1,
      idleForMs: 0,
      auth: { mode: 'local-token', hasToken: false },
      storage: { dataDir, dataDirWritable: true },
      mcp: { httpEnabled: true },
      clients: { connected: 0, ready: 0 },
    }),
  })
  return { app, layoutCore, boardId: await documentIdAt(boot.serverDeps, WS, 'board') }
}

const post = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }

describe('the file exports ask the deps for the layout core', () => {
  for (const suffix of ['export', 'export-svg'] as const) {
    it(`/${suffix} asks the deps' layout core factory`, async () => {
      const { app, layoutCore, boardId } = await appAskingForTheCore()
      const res = await app.request(`/api/workspaces/${WS}/documents/${boardId}/${suffix}`, post)
      expect(res.status).toBe(200)
      expect(layoutCore).toHaveBeenCalledTimes(1)
    })
  }
})
