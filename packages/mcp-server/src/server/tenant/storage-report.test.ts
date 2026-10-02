import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DAEMON_RECORD_FILENAME } from '../../daemon/daemon-registry.js'
import { DB_FILENAME } from '../store/db/location.js'
import { blobShardPath, blobsRoot, createDataLayout } from './data-layout.js'
import { computeStorageReport } from './storage-report.js'

const TENANT = 'self-host'
const DIGEST_A = `ab${'0'.repeat(62)}`
const DIGEST_B = `cd${'1'.repeat(62)}`

let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'storage-report-test-'))
})

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

async function seed(path: string, bytes: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, Buffer.alloc(bytes, 0xa5))
}

describe('computeStorageReport', () => {
  it('returns zeros for an empty data dir', async () => {
    const report = await computeStorageReport(dataDir)
    expect(report.totalBytes).toBe(0)
    expect(report.fileCount).toBe(0)
    for (const bucket of Object.values(report.byCategory)) {
      expect(bucket).toEqual({ bytes: 0, files: 0 })
    }
  })

  it('files each byte where the data layout puts it', async () => {
    const layout = createDataLayout(dataDir, TENANT)
    await seed(blobShardPath(blobsRoot(dataDir, TENANT), DIGEST_A), 1000)
    await seed(blobShardPath(blobsRoot(dataDir, TENANT), DIGEST_B), 2000)
    await seed(join(layout.workspaceFilesDir('ws_1'), 'image-1.png'), 4000)
    await seed(join(layout.exportsDir('ws_1'), 'canvas-a.png'), 6000)
    await seed(join(dataDir, DB_FILENAME), 8000)
    await seed(join(dataDir, `${DB_FILENAME}-wal`), 16)
    await seed(join(dataDir, DAEMON_RECORD_FILENAME), 32)
    await seed(join(dataDir, 'stray.txt'), 9)

    const report = await computeStorageReport(dataDir)

    expect(report.fileCount).toBe(8)
    expect(report.totalBytes).toBe(1000 + 2000 + 4000 + 6000 + 8000 + 16 + 32 + 9)
    expect(report.byCategory).toEqual({
      blobs: { bytes: 3000, files: 2 },
      files: { bytes: 4000, files: 1 },
      exports: { bytes: 6000, files: 1 },
      db: { bytes: 8048, files: 3 },
      other: { bytes: 9, files: 1 },
    })
  })

  it('counts every tenant, and a workspace named blobs is still a workspace', async () => {
    await seed(blobShardPath(blobsRoot(dataDir, 'tenant-two'), DIGEST_A), 300)
    await seed(join(createDataLayout(dataDir, TENANT).workspaceFilesDir('blobs'), 'f.png'), 50)

    const report = await computeStorageReport(dataDir)

    expect(report.byCategory.blobs).toEqual({ bytes: 300, files: 1 })
    expect(report.byCategory.files).toEqual({ bytes: 50, files: 1 })
  })

  it('walks recursively through nested directories', async () => {
    const layout = createDataLayout(dataDir, TENANT)
    await seed(join(layout.workspaceFilesDir('ws_1'), 'sub', 'dir', 'foo.png'), 100)
    await seed(join(layout.workspaceFilesDir('ws_2'), 'bar.png'), 200)

    const report = await computeStorageReport(dataDir)

    expect(report.fileCount).toBe(2)
    expect(report.byCategory.files.bytes).toBe(300)
  })
})
