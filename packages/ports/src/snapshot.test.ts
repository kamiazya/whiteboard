import { describe, expect, it } from 'vitest'
import { snapshotChunkSchema, snapshotManifestSchema } from './snapshot.js'

describe('snapshotChunkSchema', () => {
  it('accepts a single non-empty chunk', () => {
    const result = snapshotChunkSchema.safeParse({ index: 0, of: 1, bytes: new Uint8Array([1]) })
    expect(result.success).toBe(true)
  })

  it('rejects of: 0 (there must be at least one chunk to describe an index)', () => {
    expect(
      snapshotChunkSchema.safeParse({ index: 0, of: 0, bytes: new Uint8Array([1]) }).success,
    ).toBe(false)
  })

  it('rejects index === of', () => {
    expect(
      snapshotChunkSchema.safeParse({ index: 1, of: 1, bytes: new Uint8Array([1]) }).success,
    ).toBe(false)
  })

  it('rejects index > of', () => {
    expect(
      snapshotChunkSchema.safeParse({ index: 2, of: 1, bytes: new Uint8Array([1]) }).success,
    ).toBe(false)
  })

  it('rejects a negative or non-integer index', () => {
    expect(
      snapshotChunkSchema.safeParse({ index: -1, of: 2, bytes: new Uint8Array([1]) }).success,
    ).toBe(false)
    expect(
      snapshotChunkSchema.safeParse({ index: 0.5, of: 2, bytes: new Uint8Array([1]) }).success,
    ).toBe(false)
  })

  it('rejects bytes that are not a Uint8Array', () => {
    expect(snapshotChunkSchema.safeParse({ index: 0, of: 1, bytes: [1, 2, 3] }).success).toBe(false)
  })

  it('rejects a zero-byte chunk', () => {
    expect(
      snapshotChunkSchema.safeParse({ index: 0, of: 1, bytes: new Uint8Array() }).success,
    ).toBe(false)
  })

  it('rejects an extra unknown key (strict)', () => {
    expect(
      snapshotChunkSchema.safeParse({ index: 0, of: 1, bytes: new Uint8Array([1]), extra: 1 })
        .success,
    ).toBe(false)
  })
})

describe('snapshotManifestSchema', () => {
  it('accepts the empty-snapshot manifest (chunkCount 0, totalBytes 0)', () => {
    expect(
      snapshotManifestSchema.safeParse({ chunkCount: 0, totalBytes: 0, maxChunkBytes: 1024 })
        .success,
    ).toBe(true)
  })

  it('accepts a populated manifest', () => {
    expect(
      snapshotManifestSchema.safeParse({ chunkCount: 4, totalBytes: 10, maxChunkBytes: 4 }).success,
    ).toBe(true)
  })

  it('rejects chunkCount 0 with a non-zero totalBytes', () => {
    expect(
      snapshotManifestSchema.safeParse({ chunkCount: 0, totalBytes: 5, maxChunkBytes: 4 }).success,
    ).toBe(false)
  })

  it('rejects a positive chunkCount with a zero totalBytes', () => {
    expect(
      snapshotManifestSchema.safeParse({ chunkCount: 2, totalBytes: 0, maxChunkBytes: 4 }).success,
    ).toBe(false)
  })

  it('rejects a non-positive or non-integer maxChunkBytes', () => {
    expect(
      snapshotManifestSchema.safeParse({ chunkCount: 0, totalBytes: 0, maxChunkBytes: 0 }).success,
    ).toBe(false)
    expect(
      snapshotManifestSchema.safeParse({ chunkCount: 0, totalBytes: 0, maxChunkBytes: -1 }).success,
    ).toBe(false)
    expect(
      snapshotManifestSchema.safeParse({ chunkCount: 0, totalBytes: 0, maxChunkBytes: 1.5 })
        .success,
    ).toBe(false)
  })

  it('rejects negative chunkCount/totalBytes', () => {
    expect(
      snapshotManifestSchema.safeParse({ chunkCount: -1, totalBytes: 0, maxChunkBytes: 4 }).success,
    ).toBe(false)
    expect(
      snapshotManifestSchema.safeParse({ chunkCount: 0, totalBytes: -1, maxChunkBytes: 4 }).success,
    ).toBe(false)
  })

  it('rejects an extra unknown key (strict) and does NOT accept a docRef field', () => {
    expect(
      snapshotManifestSchema.safeParse({
        chunkCount: 0,
        totalBytes: 0,
        maxChunkBytes: 4,
        docRef: {
          kind: 'document',
          workspaceId: 'workspace-a',
          documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        },
      }).success,
    ).toBe(false)
  })
})
