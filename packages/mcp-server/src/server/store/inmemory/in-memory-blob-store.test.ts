import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { InMemoryBlobStore } from './in-memory-blob-store.js'

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('InMemoryBlobStore', () => {
  it('put computes a real sha-256 digestHex from the bytes', async () => {
    const store = new InMemoryBlobStore()
    const bytes = new Uint8Array([1, 2, 3])

    const { ref } = await store.put({ bytes })

    expect(ref).toEqual({ algorithm: 'sha-256', digestHex: sha256Hex(bytes) })
  })

  it('put is content-addressed: identical bytes yield the same ref', async () => {
    const store = new InMemoryBlobStore()
    const bytesA = new Uint8Array([1, 2, 3])
    const bytesB = new Uint8Array([1, 2, 3])

    const { ref: refA } = await store.put({ bytes: bytesA })
    const { ref: refB } = await store.put({ bytes: bytesB })

    expect(refA).toEqual(refB)
  })

  it('round-trips bytes and contentType through get', async () => {
    const store = new InMemoryBlobStore()
    const bytes = new Uint8Array([4, 5, 6])

    const { ref } = await store.put({ bytes, contentType: 'image/png' })
    const result = await store.get({ ref })

    expect(result?.bytes).toEqual(bytes)
    expect(result?.contentType).toBe('image/png')
  })

  it('has is true after put and false for an absent ref', async () => {
    const store = new InMemoryBlobStore()
    const { ref } = await store.put({ bytes: new Uint8Array([7]) })
    const absentRef = { algorithm: 'sha-256' as const, digestHex: '0'.repeat(64) }

    expect(await store.has({ ref })).toEqual({ exists: true })
    expect(await store.has({ ref: absentRef })).toEqual({ exists: false })
  })

  it('delete removes the blob so has is false and get is null', async () => {
    const store = new InMemoryBlobStore()
    const { ref } = await store.put({ bytes: new Uint8Array([8]) })

    await store.delete({ ref })

    expect(await store.has({ ref })).toEqual({ exists: false })
    expect(await store.get({ ref })).toBeNull()
  })

  it('does not let a caller mutate stored bytes after the fact', async () => {
    const store = new InMemoryBlobStore()
    const bytes = new Uint8Array([1, 2, 3])
    const { ref } = await store.put({ bytes })
    bytes[0] = 255

    const result = await store.get({ ref })
    expect(result?.bytes).toEqual(new Uint8Array([1, 2, 3]))
  })
})
