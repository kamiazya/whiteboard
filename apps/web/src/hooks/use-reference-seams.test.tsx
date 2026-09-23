import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { type ReferenceLoader, useReferenceSeams } from './use-reference-seams.js'

const B = '01BX5ZZKBKACTAV9WEVGEMMVRZ'
const C = '01BX5ZZKBKACTAV9WEVGEMMVS0'

describe('useReferenceSeams', () => {
  it('loads a directly embedded note and answers it through every seam', async () => {
    const load = vi.fn<ReferenceLoader>(async (_target, id) =>
      id === B ? { documentId: B, body: 'embedded body', name: 'Note B' } : undefined,
    )
    const { result } = renderHook(() => useReferenceSeams({ body: `before\n\n![[${B}]]\n`, load }))
    await waitFor(() => {
      expect(result.current.resolveEmbed(B)).toBeDefined()
    })
    const embedded = result.current.resolveEmbed(B)
    expect(embedded?.title).toBe('Note B')
    expect(JSON.stringify(embedded)).toContain('embedded body')
    expect(result.current.resolveTitle(B)).toBe('Note B')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('asks a rejected load again, so one failed store read does not blank an embed for good', async () => {
    // The flake this closes: a transient IndexedDB read threw, the loader
    // reported it as "this document has no content", and the prefetch cached
    // that as terminal — the embed kept its placeholder for the life of the
    // page, with the name beside it (which comes from the page's own table,
    // not from the load) and nothing logged.
    let asked = 0
    const load = vi.fn<ReferenceLoader>(async () => {
      asked += 1
      if (asked === 1) throw new Error('the store could not be read')
      return { documentId: B, body: 'embedded body', name: 'Note B' }
    })
    const { result } = renderHook(() => useReferenceSeams({ body: `![[${B}]]`, load }))
    await waitFor(() => {
      expect(JSON.stringify(result.current.resolveEmbed(B))).toContain('embedded body')
    })
    expect(asked).toBe(2)
    await expectLoggedFailure('reference load failed')
  })

  it("answers an inline image's picture, which is the whole point of the seam", async () => {
    // The preview draws `![](asset:…)` through `resolveReference`. Without a
    // picture on this side the layout keeps the written path, so a workspace
    // attachment rendered as a broken image while the same asset drew fine
    // on a board.
    const loadImage = vi.fn(async (ref: string) => `blob:${ref}`)
    const { result } = renderHook(() =>
      useReferenceSeams({
        body: 'see ![shot](asset:pic) here',
        load: async () => undefined,
        loadImage,
      }),
    )
    await waitFor(() =>
      expect(result.current.resolveReference('asset:pic')).toEqual({
        image: { href: 'blob:asset:pic' },
      }),
    )
    expect(loadImage).toHaveBeenCalledTimes(1)
  })

  it('follows an embedded note, so a picture one level down loads too', async () => {
    const loadImage = vi.fn(async (ref: string) => `blob:${ref}`)
    const load = vi.fn<ReferenceLoader>(async (_target, id) =>
      id === B ? { documentId: B, body: '![](asset:deep)' } : undefined,
    )
    const { result } = renderHook(() => useReferenceSeams({ body: `![[${B}]]`, load, loadImage }))
    await waitFor(() =>
      expect(result.current.resolveReference('asset:deep')?.image).toEqual({
        href: 'blob:asset:deep',
      }),
    )
  })

  it('asks for no picture when the host supplies no loader', async () => {
    const { result } = renderHook(() =>
      useReferenceSeams({ body: '![](asset:pic)', load: async () => undefined }),
    )
    await waitFor(() => expect(result.current.resolveReference('asset:pic')).toBeUndefined())
  })

  it('a canvas target is answered as a canvas, unparsed', async () => {
    const canvas: SpatialCanvas = {
      nodes: [textNode({ id: 'n1', x: 0, y: 0, width: 200, height: 100, text: 'board node' })],
      edges: [],
    }
    const load = vi.fn<ReferenceLoader>(async (_target, id) =>
      id === B ? { documentId: B, canvas, name: 'Board' } : undefined,
    )
    const { result } = renderHook(() => useReferenceSeams({ body: `![[${B}]]\n`, load }))
    await waitFor(() => {
      expect(result.current.resolveEmbed(B)).toBeDefined()
    })
    expect(result.current.resolveEmbed(B)).toEqual({ title: 'Board', canvas })
  })

  it('follows transitive references so nested bodies resolve too', async () => {
    const docs: Record<string, { body: string }> = {
      [B]: { body: `![[${C}]]\n` },
      [C]: { body: 'leaf body' },
    }
    const load = vi.fn<ReferenceLoader>(async (_target, id) =>
      id !== null && docs[id] ? { documentId: id, ...docs[id] } : undefined,
    )
    const { result } = renderHook(() => useReferenceSeams({ body: `![[${B}]]\n`, load }))
    await waitFor(() => {
      expect(result.current.resolveEmbed(C)).toBeDefined()
    })
    expect(JSON.stringify(result.current.resolveEmbed(C))).toContain('leaf body')
  })

  it('resolves a path through the page table, loads by the id it names, and still answers the alias', async () => {
    const load = vi.fn<ReferenceLoader>(async (target, id) =>
      target === 'notes/named' && id === B ? { documentId: B, body: 'named body' } : undefined,
    )
    const { result } = renderHook(() =>
      useReferenceSeams({
        body: '![[notes/named]]\n',
        resolveAlias: (alias) => (alias === 'notes/named' ? B : null),
        load,
      }),
    )
    await waitFor(() => {
      expect(result.current.resolveEmbed(B)).toBeDefined()
    })
    expect(result.current.resolveAlias('notes/named')).toBe(B)
    expect(load).toHaveBeenCalledWith('notes/named', B)
  })

  it('a failed load resolves to nothing without retry storms', async () => {
    const load = vi.fn<ReferenceLoader>(async () => undefined)
    const { result } = renderHook(() => useReferenceSeams({ body: `![[${B}]]\n`, load }))
    const before = result.current
    // The failure lands in the cache as a terminal slot, which rebuilds the
    // bundle; the render that carries it re-runs the prefetch effect, and
    // that re-run is where a retry would fire.
    await waitFor(() => {
      expect(result.current).not.toBe(before)
    })
    expect(result.current.resolveEmbed(B)).toBeUndefined()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('a load that resolves after further typing still lands in the cache', async () => {
    // The stuck-placeholder bug: a keystroke re-runs the effect while the
    // load is in flight; the new pass skips the target as inflight, and the
    // OLD pass's result must not be dropped — nothing would ever re-fire it.
    let release: (value: { documentId: string; body: string } | undefined) => void = () => {}
    const gate = new Promise<{ documentId: string; body: string } | undefined>((resolve) => {
      release = resolve
    })
    const load = vi.fn<ReferenceLoader>(() => gate)
    const { result, rerender } = renderHook(({ body }) => useReferenceSeams({ body, load }), {
      initialProps: { body: `![[${B}]]\n` },
    })
    await waitFor(() => {
      expect(load).toHaveBeenCalledTimes(1)
    })
    rerender({ body: `![[${B}]]\n\nmore typing` })
    release({ documentId: B, body: 'late but wanted' })
    await waitFor(() => {
      expect(JSON.stringify(result.current.resolveEmbed(B))).toContain('late but wanted')
    })
    expect(load).toHaveBeenCalledTimes(1)
  })
})
