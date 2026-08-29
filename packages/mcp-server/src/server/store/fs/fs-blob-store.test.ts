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

/**
 * A blob must never be observable half-written.
 *
 * `put` is idempotent by design — the store is content-addressed, so the same
 * bytes always land on the same path — which makes REWRITING an existing blob
 * an ordinary event rather than an edge case. Re-uploading an image, or two
 * people uploading the same file, does it.
 *
 * A plain `writeFile` opens with O_TRUNC, so for the whole duration of that
 * write the blob is short. Anyone reading it in that window gets a truncated
 * JSON envelope, which `get` correctly refuses to parse — so the read fails
 * for a blob that is present, complete and unchanged either side of it.
 *
 * Measured before the fix, on a 6 MiB blob: 8 reads during 8 re-puts,
 * `readable=0 threw-corrupt=8`. Not a narrow race — the window is as long as
 * the write.
 *
 * The same window is what makes a hot backup impossible: 12 of 12 directory
 * copies taken during a rewrite captured a truncated file. ADR-0021 decision
 * 3 removes the stop-the-server requirement for the ROWS, and this is the
 * matching half for the blobs.
 */
describe('FsBlobStore concurrent rewrite', () => {
  it('keeps an existing blob readable while the same bytes are put again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fs-blob-rewrite-'))
    try {
      const store = new FsBlobStore(dir)
      // Large enough that the write spans many reads. A small blob can finish
      // inside one scheduler turn and hide the window entirely.
      const bytes = new Uint8Array(6 * 1024 * 1024).fill(0x41)
      const { ref } = await store.put({ bytes, contentType: 'image/png' })

      const reads: Array<Promise<number | string>> = []
      const writing = store.put({ bytes, contentType: 'image/png' })
      for (let i = 0; i < 8; i++) {
        reads.push(
          store
            .get({ ref })
            .then((got) => got?.bytes.length ?? -1)
            .catch((err) => (isCorruptStoredDataError(err) ? 'corrupt' : `other: ${err}`)),
        )
      }
      const results = await Promise.all(reads)
      await writing

      // Every read sees the whole blob. None sees a truncated envelope, and
      // none sees a zero-length one.
      expect(results).toEqual(Array.from({ length: 8 }, () => bytes.length))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  /**
   * The temp file must not be left behind, or the shard directory accumulates
   * one per write and the blob directory stops being purely content-addressed
   * — file-GC walks it by digest name and would find entries it cannot match.
   */
  it('leaves no temporary files in the shard directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fs-blob-tmp-'))
    try {
      const store = new FsBlobStore(dir)
      const bytes = new Uint8Array(1024).fill(0x42)
      const { ref } = await store.put({ bytes, contentType: 'image/png' })
      await store.put({ bytes, contentType: 'image/png' })

      const shard = join(dir, 'blobs', ref.digestHex.slice(0, 2))
      expect(await readdir(shard)).toEqual([ref.digestHex.slice(2)])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
