import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BlobRef } from '@kamiazya/whiteboard-canvas-ports'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InMemoryBlobStore } from '../inmemory/in-memory-blob-store.js'
import { FsBlobStore } from './fs-blob-store.js'

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

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
  let baseDir: string
  let store: FsBlobStore

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'fs-blob-store-'))
    store = new FsBlobStore(baseDir)
  })

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true })
  })

  it('put computes a real sha-256 digestHex from the bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3])

    const { ref } = await store.put({ bytes })

    expect(ref).toEqual({ algorithm: 'sha-256', digestHex: sha256Hex(bytes) })
  })

  it('round-trips bytes and contentType through get', async () => {
    const bytes = new Uint8Array([4, 5, 6])

    const { ref } = await store.put({ bytes, contentType: 'image/png' })
    const result = await store.get({ ref })

    expect(result?.bytes).toEqual(bytes)
    expect(result?.contentType).toBe('image/png')
  })

  it('has is true after put and false for an absent ref', async () => {
    const { ref } = await store.put({ bytes: new Uint8Array([7]) })
    const absentRef: BlobRef = { algorithm: 'sha-256', digestHex: '0'.repeat(64) }

    expect(await store.has({ ref })).toEqual({ exists: true })
    expect(await store.has({ ref: absentRef })).toEqual({ exists: false })
  })

  it('delete removes the blob so has is false and get is null', async () => {
    const { ref } = await store.put({ bytes: new Uint8Array([8]) })

    await store.delete({ ref })

    expect(await store.has({ ref })).toEqual({ exists: false })
    expect(await store.get({ ref })).toBeNull()
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

  it('is total on unknown refs: get null, has false, delete does not throw', async () => {
    const unknownRef: BlobRef = { algorithm: 'sha-256', digestHex: '1'.repeat(64) }

    expect(await store.get({ ref: unknownRef })).toBeNull()
    expect(await store.has({ ref: unknownRef })).toEqual({ exists: false })
    await expect(store.delete({ ref: unknownRef })).resolves.toBeUndefined()
  })

  it('is total on empty bytes', async () => {
    const bytes = new Uint8Array([])

    const { ref } = await store.put({ bytes })

    expect(ref.digestHex).toBe(sha256Hex(bytes))
    const result = await store.get({ ref })
    expect(result?.bytes).toEqual(bytes)
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
