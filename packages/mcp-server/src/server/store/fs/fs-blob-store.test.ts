import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { BlobRef } from '@kamiazya/whiteboard-ports'
import { describeBlobStoreConformance } from '@kamiazya/whiteboard-ports/test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isCorruptStoredDataError } from '../corrupt-stored-data.js'
import { InMemoryBlobStore } from '../inmemory/in-memory-blob-store.js'
import { FsBlobStore } from './fs-blob-store.js'

async function countFilesRecursively(dir: string): Promise<number> {
  let count = 0
  let entries: Awaited<ReturnType<typeof readdir>>
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      count += await countFilesRecursively(join(dir, entry.name))
    } else if (entry.isFile()) {
      count += 1
    }
  }
  return count
}

describe('FsBlobStore', () => {
  // The shared guarantees. What stays written out below is what only THIS
  // store can be asked: its on-disk layout, its envelope, and the failures
  // a filesystem has that a Map does not.
  describeBlobStoreConformance(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fs-blob-conformance-'))
    return {
      store: new FsBlobStore(dir),
      dispose: () => rm(dir, { recursive: true, force: true }),
    }
  })

  let baseDir: string
  let store: FsBlobStore

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'fs-blob-store-'))
    store = new FsBlobStore(baseDir)
  })

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true })
  })

  it('does not swallow non-missing delete failures', async () => {
    // A directory sitting where the blob file is expected makes `rm` fail
    // with EISDIR (not ENOENT), which must propagate rather than be
    // treated as an already-deleted blob.
    const ref: BlobRef = { algorithm: 'sha-256', digestHex: '5'.repeat(64) }
    const filePath = join(baseDir, 'blobs', ref.digestHex.slice(0, 2), ref.digestHex.slice(2))
    await mkdir(filePath, { recursive: true })

    await expect(store.delete({ ref })).rejects.toMatchObject({ code: 'ERR_FS_EISDIR' })
  })

  it('is content-addressed: identical bytes yield the same ref and dedup to one file', async () => {
    const bytesA = new Uint8Array([9, 9, 9])
    const bytesB = new Uint8Array([9, 9, 9])

    const { ref: refA } = await store.put({ bytes: bytesA })
    const { ref: refB } = await store.put({ bytes: bytesB })

    expect(refA).toEqual(refB)
    expect(await countFilesRecursively(join(baseDir, 'blobs'))).toBe(1)
  })

  it('gives distinct refs and distinct files for distinct bytes', async () => {
    const { ref: refA } = await store.put({ bytes: new Uint8Array([1]) })
    const { ref: refB } = await store.put({ bytes: new Uint8Array([2]) })

    expect(refA).not.toEqual(refB)
    expect(await countFilesRecursively(join(baseDir, 'blobs'))).toBe(2)
  })

  it('stores the blob sharded by hash prefix: <baseDir>/blobs/<first2>/<remaining62>', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const { ref } = await store.put({ bytes })

    const shardDir = join(baseDir, 'blobs', ref.digestHex.slice(0, 2))
    const entries = await readdir(shardDir)

    expect(entries).toEqual([ref.digestHex.slice(2)])
  })

  it('get throws CorruptStoredDataError when the on-disk envelope is malformed JSON', async () => {
    const ref: BlobRef = { algorithm: 'sha-256', digestHex: '3'.repeat(64) }
    const filePath = join(baseDir, 'blobs', ref.digestHex.slice(0, 2), ref.digestHex.slice(2))
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, 'not json', 'utf8')

    const error = await store.get({ ref }).catch((err: unknown) => err)

    expect(isCorruptStoredDataError(error)).toBe(true)
  })

  it('get throws CorruptStoredDataError when the envelope is missing bytesBase64', async () => {
    const ref: BlobRef = { algorithm: 'sha-256', digestHex: '4'.repeat(64) }
    const filePath = join(baseDir, 'blobs', ref.digestHex.slice(0, 2), ref.digestHex.slice(2))
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify({ contentType: 'image/png' }), 'utf8')

    const error = await store.get({ ref }).catch((err: unknown) => err)

    expect(isCorruptStoredDataError(error)).toBe(true)
  })

  it('matches InMemoryBlobStore observable behavior across a fixed operation sequence', async () => {
    const oracle = new InMemoryBlobStore()
    const bytesA = new Uint8Array([1, 2, 3])
    const bytesB = new Uint8Array([4, 5, 6])
    const unknownRef: BlobRef = { algorithm: 'sha-256', digestHex: '2'.repeat(64) }

    const putA1 = await store.put({ bytes: bytesA })
    const oraclePutA1 = await oracle.put({ bytes: bytesA })
    expect(putA1).toEqual(oraclePutA1)

    const putA2 = await store.put({ bytes: bytesA })
    const oraclePutA2 = await oracle.put({ bytes: bytesA })
    expect(putA2).toEqual(oraclePutA2)

    const putB = await store.put({ bytes: bytesB })
    const oraclePutB = await oracle.put({ bytes: bytesB })
    expect(putB).toEqual(oraclePutB)

    const refA = putA1.ref
    const refB = putB.ref

    expect(await store.get({ ref: refA })).toEqual(await oracle.get({ ref: refA }))
    expect(await store.has({ ref: refA })).toEqual(await oracle.has({ ref: refA }))

    await store.delete({ ref: refA })
    await oracle.delete({ ref: refA })

    expect(await store.get({ ref: refA })).toEqual(await oracle.get({ ref: refA }))
    expect(await store.has({ ref: refB })).toEqual(await oracle.has({ ref: refB }))
    expect(await store.get({ ref: unknownRef })).toEqual(await oracle.get({ ref: unknownRef }))
    await expect(store.delete({ ref: unknownRef })).resolves.toBeUndefined()
    await expect(oracle.delete({ ref: unknownRef })).resolves.toBeUndefined()
  })
})
