/**
 * Which storage category a daemon operation grows, through the real app and
 * the real data directory.
 *
 * The category keys predate the daemon's layout and were labelled from the
 * browser's: `blobs` read as "snapshots" or "images", while on the daemon its
 * only writer is the trash evacuation of a deleted document and an uploaded
 * image goes under a workspace's `files/`. A label describing the wrong
 * directory sends a reader to the wrong row, so what each category holds is
 * pinned here from the operations that fill it.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StorageCategory } from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import { wbDocumentCreate, wbDocumentDelete } from '@kamiazya/whiteboard-server-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bootSelfHostDeps } from '../../di/boot-self-host-deps.js'
import { resetDataDirForTests, setDataDirForTests } from '../../shared/data-dir-secure.js'
import { PACKAGE_VERSION } from '../../shared/package-version.js'
import { createApp } from '../app.js'
import { disposeAutoCompact, uninstallAutoCompact } from '../store/auto-compact.js'
import { clearDbCacheForTests, closeDb } from '../store/db/index.js'
import { clearDocCacheForTests } from '../store/doc-cache.js'
import { _clearWorkspaceDocCacheForTests } from '../store/workspace-doc-cache.js'
import { computeStorageReport } from './storage-report.js'

const WS = 'ws-1'
const IMAGE = new Uint8Array(4096).fill(0x89)

let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'wb-storage-categories-'))
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
  vi.unstubAllEnvs()
  await rm(dataDir, { recursive: true, force: true })
})

async function bootDaemon() {
  const boot = await bootSelfHostDeps(dataDir)
  await boot.serverDeps.documentIndex.createWorkspace({ workspaceId: WS })
  const created = await wbDocumentCreate(boot.serverDeps, {
    workspaceId: WS,
    path: 'note',
    kind: 'spatial',
  })
  const app = createApp({
    authMode: 'local-daemon',
    serverDeps: boot.serverDeps,
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
  return { boot, app, documentId: created.documentId }
}

async function bytesByCategory(): Promise<Record<StorageCategory, number>> {
  const { byCategory } = await computeStorageReport(dataDir)
  return {
    blobs: byCategory.blobs.bytes,
    files: byCategory.files.bytes,
    exports: byCategory.exports.bytes,
    db: byCategory.db.bytes,
    other: byCategory.other.bytes,
  }
}

describe('what each storage category holds on the daemon', () => {
  it('files a deleted document under blobs, where the trash can restore it from', async () => {
    const { boot, documentId } = await bootDaemon()
    const before = await bytesByCategory()
    expect(before.blobs).toBe(0)

    await wbDocumentDelete(boot.serverDeps, { workspaceId: WS, documentId })

    const after = await bytesByCategory()
    expect(after.blobs).toBeGreaterThan(0)
    expect(after.files).toBe(before.files)
  })

  it('files an uploaded image under files, leaving blobs alone', async () => {
    const { app } = await bootDaemon()
    const before = await bytesByCategory()

    const res = await app.request(`/api/w/${WS}/document/note/file/image-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: IMAGE,
    })
    expect(res.status).toBe(204)

    const after = await bytesByCategory()
    expect(after.files - before.files).toBe(IMAGE.byteLength)
    expect(after.blobs).toBe(before.blobs)
  })

  it('keeps a document, its history and its index in the database, not in blobs', async () => {
    const { boot, documentId } = await bootDaemon()
    const doc = await boot.serverDeps.liveDocuments.get(WS, 'note')
    await boot.serverDeps.versions.save(WS, 'note', doc, { auto: false })

    const report = await bytesByCategory()

    expect(report.db).toBeGreaterThan(0)
    expect(report.blobs).toBe(0)
    expect(documentId).toBeTruthy()
  })
})
