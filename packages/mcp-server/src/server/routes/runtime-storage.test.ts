import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computeStorageReport } from './runtime-storage.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'storage-report-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

async function seed(file: string, bytes: number): Promise<void> {
  const full = join(tempDir, file)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, Buffer.alloc(bytes, 0xa5))
}

describe('computeStorageReport', () => {
  it('returns zeros for an empty data dir', async () => {
    const report = await computeStorageReport(tempDir)
    expect(report.totalBytes).toBe(0)
    expect(report.fileCount).toBe(0)
    for (const bucket of Object.values(report.byCategory)) {
      expect(bucket.bytes).toBe(0)
      expect(bucket.files).toBe(0)
    }
  })

  it('categorises canvas blobs, version thumbnails, files, db, exports, logs, and other', async () => {
    // Match the layout the daemon actually writes — uploaded files live
    // under <DATA_DIR>/<workspaceId>/files/ (document-store.ts), so the
    // categorizer has to recognise the real per-workspace paths, not the
    // top-level shorthand.
    await seed('blobs/ws_1/document/abc.loro', 1000)
    await seed('blobs/ws_1/document/def.loro', 2000)
    await seed('blobs/ws_1/versions/v1.png', 500) // version thumbnail
    await seed('ws_1/files/image-1.png', 4000) // user-uploaded image (real layout)
    await seed('whiteboard.db', 8000)
    await seed('whiteboard.db-wal', 16) // SQLite WAL
    await seed('daemon.json', 32) // runtime metadata folded into "db"
    await seed('logs/daemon-2026-05-01.log', 75) // dedicated logs bucket
    await seed('ws_1/exports/canvas-a.png', 6000) // dedicated exports bucket
    await seed('stray.txt', 9) // genuinely unclassified → other

    const report = await computeStorageReport(tempDir)
    expect(report.fileCount).toBe(10)
    expect(report.totalBytes).toBe(1000 + 2000 + 500 + 4000 + 8000 + 16 + 32 + 75 + 6000 + 9)

    expect(report.byCategory.blobs).toEqual({ bytes: 3000, files: 2 })
    expect(report.byCategory.versions).toEqual({ bytes: 500, files: 1 })
    expect(report.byCategory.files).toEqual({ bytes: 4000, files: 1 })
    expect(report.byCategory.db).toEqual({ bytes: 8048, files: 3 })
    expect(report.byCategory.logs).toEqual({ bytes: 75, files: 1 })
    expect(report.byCategory.exports).toEqual({ bytes: 6000, files: 1 })
    expect(report.byCategory.other).toEqual({ bytes: 9, files: 1 })
  })

  it('walks recursively through deeply nested workspaces', async () => {
    await seed('blobs/ws_1/document/sub/dir/foo.loro', 100)
    await seed('blobs/ws_2/document/bar.loro', 200)
    const report = await computeStorageReport(tempDir)
    expect(report.fileCount).toBe(2)
    expect(report.byCategory.blobs.bytes).toBe(300)
  })
})
