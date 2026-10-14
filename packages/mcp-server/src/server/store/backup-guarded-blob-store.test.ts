import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BlobStore } from '@kamiazya/whiteboard-ports'
import { describeBlobStoreConformance } from '@kamiazya/whiteboard-ports/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { blobsRoot } from '../tenant/data-layout.js'
import { SELF_HOST_TENANT_ID } from '../tenant/id.js'
import { BackupGuardedBlobStore, daemonBlobStore } from './backup-guarded-blob-store.js'
import { withBackupMarker } from './backup-in-progress.js'
import { FsBlobStore } from './fs/fs-blob-store.js'

const BYTES = new TextEncoder().encode('trashed document')

describe('the daemon blob store', () => {
  describeBlobStoreConformance(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guarded-blob-conformance-'))
    const blobsDir = blobsRoot(dir, SELF_HOST_TENANT_ID)
    return {
      store: new BackupGuardedBlobStore(new FsBlobStore(blobsDir, dir), dir, blobsDir),
      dispose: () => rm(dir, { recursive: true, force: true }),
    }
  })

  let dataDir: string
  let store: BlobStore
  /** The bytes on disk, read past the guard. */
  let disk: FsBlobStore

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'guarded-blob-'))
    store = daemonBlobStore(dataDir, SELF_HOST_TENANT_ID)
    disk = new FsBlobStore(blobsRoot(dataDir, SELF_HOST_TENANT_ID), dataDir)
  })
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('defers a delete while a backup runs, and reads the blob as already gone', async () => {
    const { ref } = await store.put({ bytes: BYTES })

    await withBackupMarker(dataDir, async () => {
      await store.delete({ ref })
      expect(await disk.has({ ref })).toEqual({ exists: true })
      expect(await store.get({ ref })).toBeNull()
      expect(await store.has({ ref })).toEqual({ exists: false })
    })

    expect(await disk.has({ ref })).toEqual({ exists: true })
    // The next call after the marker drops applies it.
    expect(await store.has({ ref })).toEqual({ exists: false })
    expect(await disk.has({ ref })).toEqual({ exists: false })
  })

  it('applies a deferred delete through any store over the same directory', async () => {
    const { ref } = await store.put({ bytes: BYTES })
    await withBackupMarker(dataDir, () => store.delete({ ref }))

    await daemonBlobStore(dataDir, SELF_HOST_TENANT_ID).has({
      ref: { ...ref, digestHex: '0'.repeat(64) },
    })

    expect(await disk.has({ ref })).toEqual({ exists: false })
  })

  it('keeps the bytes when they are put again before the backup ends', async () => {
    const { ref } = await store.put({ bytes: BYTES })

    await withBackupMarker(dataDir, async () => {
      await store.delete({ ref })
      await store.put({ bytes: BYTES })
    })

    expect(await store.get({ ref })).not.toBeNull()
    expect(await disk.has({ ref })).toEqual({ exists: true })
  })
})
