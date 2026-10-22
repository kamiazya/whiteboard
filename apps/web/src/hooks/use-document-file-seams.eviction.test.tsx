/**
 * How much of a referenced document's history the editor keeps.
 *
 * A prefetch key is the reference and the stamp it was asked under, so every
 * edit made elsewhere is a new key. Kept forever, a long session holds every
 * revision of every note it ever drew. What is worth keeping is the answer
 * under the current stamp, and one older answer only while that one loads, so
 * the embed never flashes empty.
 */
import { referenceSeamsFromWire } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode } from '@kamiazya/whiteboard-model/test-utils'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocumentFileAdapter, LoadedFileDocument } from '../lib/document-file-contract.js'
import { useDocumentFileSeams } from './use-document-file-seams.js'

const seen = vi.hoisted(() => ({
  cache: new Map<string, unknown>() as ReadonlyMap<string, unknown>,
}))

vi.mock('./use-prefetched-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./use-prefetched-cache.js')>()
  return {
    ...actual,
    usePrefetchedEntries: (...args: Parameters<typeof actual.usePrefetchedEntries>) => {
      const cache = actual.usePrefetchedEntries(...args)
      seen.cache = cache
      return cache
    },
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

const canvas: SpatialCanvas = {
  nodes: [fileNode({ id: 'n', x: 0, y: 0, width: 10, height: 10, file: 'other' })],
  edges: [],
}

const keysFor = (ref: string) =>
  [...seen.cache.keys()].filter((key) => key.startsWith(`${ref}\u0000`))

describe('a referenced document whose stamp keeps moving', () => {
  it('keeps at most the current answer and one older one', async () => {
    const adapter: DocumentFileAdapter = {
      fileScope: 'test',
      isImageRef: () => false,
      loadDocument: vi.fn(async (): Promise<LoadedFileDocument> => ({ body: 'revision' })),
      loadImageUrl: vi.fn(async (ref: string) => `blob:${ref}`),
      loadImageBlob: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
      storeImage: vi.fn(async () => ({ ok: true as const, ref: 'asset:new' })),
    }
    const bodies: readonly string[] = []
    const { result, rerender } = renderHook(
      ({ stampOf }: { stampOf: ReadonlyMap<string, string> }) =>
        useDocumentFileSeams({ canvas, adapter, stampOf, bodies }),
      { initialProps: { stampOf: new Map([['other', 'v0']]) as ReadonlyMap<string, string> } },
    )
    const moves = 20
    for (let i = 1; i <= moves; i += 1) {
      await act(async () => {
        rerender({ stampOf: new Map([['other', `v${i}`]]) })
      })
      await waitFor(() => expect(keysFor('other')).toContain(`other\u0000v${i}`))
      expect(keysFor('other').length).toBeLessThanOrEqual(2)
    }
    expect(adapter.loadDocument).toHaveBeenCalledTimes(moves + 1)
    expect(
      referenceSeamsFromWire(result.current.references).resolveReference('other'),
    ).toBeDefined()
  })

  it('draws the older answer while the current one is still loading', async () => {
    let release: (document: LoadedFileDocument) => void = () => {}
    const loadDocument = vi
      .fn<DocumentFileAdapter['loadDocument']>()
      .mockResolvedValueOnce({ body: 'first' })
      .mockResolvedValueOnce({ body: 'second' })
      .mockImplementationOnce(
        () =>
          new Promise<LoadedFileDocument>((resolve) => {
            release = resolve
          }),
      )
    const adapter: DocumentFileAdapter = {
      fileScope: 'test',
      isImageRef: () => false,
      loadDocument,
      loadImageUrl: vi.fn(async (ref: string) => `blob:${ref}`),
      loadImageBlob: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
      storeImage: vi.fn(async () => ({ ok: true as const, ref: 'asset:new' })),
    }
    const bodies: readonly string[] = []
    const { result, rerender } = renderHook(
      ({ stampOf }: { stampOf: ReadonlyMap<string, string> }) =>
        useDocumentFileSeams({ canvas, adapter, stampOf, bodies }),
      { initialProps: { stampOf: new Map([['other', 'v1']]) as ReadonlyMap<string, string> } },
    )
    const bodyOf = () =>
      result.current.references.entries.find(([key]) => key === 'other')?.[1]?.body
    await waitFor(() => expect(bodyOf()).toBe('first'))
    rerender({ stampOf: new Map([['other', 'v2']]) })
    await waitFor(() => expect(bodyOf()).toBe('second'))
    rerender({ stampOf: new Map([['other', 'v3']]) })
    await waitFor(() => expect(loadDocument).toHaveBeenCalledTimes(3))
    expect(bodyOf()).toBe('second')
    await act(async () => {
      release({ body: 'third' })
    })
    await waitFor(() => expect(bodyOf()).toBe('third'))
    expect(keysFor('other')).toEqual(['other\u0000v3'])
  })
})
