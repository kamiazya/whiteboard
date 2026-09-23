import type { DocumentEntry } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { ContentFactsCache, type DocumentContentSource } from './content-facts-cache.js'

const WS = 'ws-1'
const A = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const B = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

function entry(documentId: string, kind: DocumentEntry['kind'] = 'markdown'): DocumentEntry {
  return { workspaceId: WS, documentId, path: documentId.toLowerCase(), kind } as DocumentEntry
}

/**
 * A keeper reduced to what the cache asks of it: version bytes per document
 * (null = nothing stored), and a count of how often it had to load one.
 */
function fakeSource(frontiers: Map<string, Uint8Array | null>) {
  const loads: string[] = []
  const source: DocumentContentSource = {
    async readVersions(_workspaceId, documentIds) {
      return new Map(documentIds.map((id) => [id, frontiers.get(id) ?? null]))
    },
    async loadDocument(_workspaceId, documentId) {
      loads.push(documentId)
      return new LoroDoc()
    },
  }
  return { source, loads }
}

describe('ContentFactsCache over a keeper port', () => {
  it('loads a document once while its frontier bytes stay the same', async () => {
    const { source, loads } = fakeSource(new Map([[A, new Uint8Array([1])]]))
    const cache = new ContentFactsCache(source)

    await cache.factsFor(WS, [entry(A)])
    await cache.factsFor(WS, [entry(A)])

    expect(loads).toEqual([A])
  })

  it('loads again once the frontier moves', async () => {
    const frontiers = new Map<string, Uint8Array | null>([[A, new Uint8Array([1])]])
    const { source, loads } = fakeSource(frontiers)
    const cache = new ContentFactsCache(source)

    await cache.factsFor(WS, [entry(A)])
    const before = cache.stampOf(WS, A)
    frontiers.set(A, new Uint8Array([2]))
    await cache.factsFor(WS, [entry(A)])

    expect(loads).toEqual([A, A])
    expect(cache.stampOf(WS, A)).not.toBe(before)
  })

  // Extraction branches on the kind, so facts read as one kind are not facts
  // about the other, whatever the bytes say.
  it('treats a changed kind as a changed document', async () => {
    const { source, loads } = fakeSource(new Map([[A, new Uint8Array([1])]]))
    const cache = new ContentFactsCache(source)

    await cache.factsFor(WS, [entry(A, 'markdown')])
    await cache.factsFor(WS, [entry(A, 'spatial')])

    expect(loads).toEqual([A, A])
  })

  it('answers empty facts for a document with nothing stored, without loading it', async () => {
    const { source, loads } = fakeSource(new Map([[A, null]]))
    const cache = new ContentFactsCache(source)

    const facts = await cache.factsFor(WS, [entry(A)])

    expect(facts.get(A)).toEqual({ refs: [], texts: [], bearers: [] })
    expect(loads).toEqual([])
    expect(cache.stampOf(WS, A)).toBeUndefined()
  })

  // A companion cache keys on `stampOf`, so a stamp left behind here would
  // keep answering for content the keeper no longer holds.
  it('drops the stamp of a document whose stored content went away', async () => {
    const frontiers = new Map<string, Uint8Array | null>([[A, new Uint8Array([1])]])
    const { source } = fakeSource(frontiers)
    const cache = new ContentFactsCache(source)

    await cache.factsFor(WS, [entry(A)])
    frontiers.set(A, null)
    await cache.factsFor(WS, [entry(A)])

    expect(cache.stampOf(WS, A)).toBeUndefined()
  })

  it('forgets a document the listing no longer holds', async () => {
    const { source } = fakeSource(
      new Map([
        [A, new Uint8Array([1])],
        [B, new Uint8Array([2])],
      ]),
    )
    const cache = new ContentFactsCache(source)

    await cache.factsFor(WS, [entry(A), entry(B)])
    await cache.factsFor(WS, [entry(A)])

    expect(cache.stampOf(WS, A)).toBeDefined()
    expect(cache.stampOf(WS, B)).toBeUndefined()
  })
})
