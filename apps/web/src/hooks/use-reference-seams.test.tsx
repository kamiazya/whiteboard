import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RETIRED_PICTURE, RETIRED_PICTURE_LABEL } from '../lib/document-file-contract.js'
import { askCore, rowOf, wireSeenByCore } from '../test-utils/core-wire.js'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { type ReferenceLoader, useReferenceSeams } from './use-reference-seams.js'

const B = '01BX5ZZKBKACTAV9WEVGEMMVRZ'
const C = '01BX5ZZKBKACTAV9WEVGEMMVS0'

/** What the core is handed for one reference: the loaded record and the surface's extra. */
const seenOf = (seams: Parameters<typeof wireSeenByCore>[0], ref: string) =>
  rowOf(wireSeenByCore(seams), ref)

describe('useReferenceSeams', () => {
  it('loads a directly embedded note, which the core is handed raw with its name', async () => {
    const load = vi.fn<ReferenceLoader>(async (_target, id) =>
      id === B ? { documentId: B, body: 'embedded body', name: 'Note B' } : undefined,
    )
    const { result } = renderHook(() => useReferenceSeams({ body: `before\n\n![[${B}]]\n`, load }))
    await waitFor(() => {
      expect(seenOf(result.current, B).record).toBeDefined()
    })
    expect(seenOf(result.current, B).record).toEqual({
      documentId: B,
      body: 'embedded body',
      name: 'Note B',
    })
    expect(result.current.resolveTitle(B)).toBe('Note B')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('reports a target pending while its load is in flight, then neither pending nor missing', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const load = vi.fn<ReferenceLoader>(async () => {
      await gate
      return { documentId: B, body: 'embedded body', name: 'Note B' }
    })
    const { result } = renderHook(() => useReferenceSeams({ body: `![[${B}]]`, load }))
    expect(seenOf(result.current, B).extra).toEqual({ pending: true })
    release?.()
    await waitFor(() => expect(seenOf(result.current, B).record).toBeDefined())
    expect(seenOf(result.current, B).extra?.pending).toBeUndefined()
  })

  it('does not report a target pending once it answered that nothing is there', async () => {
    const { result } = renderHook(() =>
      useReferenceSeams({ body: `![[${B}]]`, load: async () => undefined }),
    )
    await waitFor(() => expect(seenOf(result.current, B).extra?.pending).toBeUndefined())
    expect(seenOf(result.current, B).record ?? null).toBeNull()
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
      expect(seenOf(result.current, B).record?.body).toBe('embedded body')
    })
    expect(asked).toBe(2)
    await expectLoggedFailure('reference load failed')
  })

  it("hands the core an inline image's picture, which is the whole point of the seam", async () => {
    // The preview draws `![](asset:…)` from the extra the wire carries. Without a
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
      expect(seenOf(result.current, 'asset:pic').extra).toEqual({
        image: { href: 'blob:asset:pic' },
      }),
    )
    expect(loadImage).toHaveBeenCalledTimes(1)
  })

  it('labels a picture saved in a retired form rather than drawing the written path', async () => {
    const loadImage = vi.fn(async () => RETIRED_PICTURE)
    const { result } = renderHook(() =>
      useReferenceSeams({
        body: 'see ![shot](asset:old) here',
        load: async () => undefined,
        loadImage,
      }),
    )
    await waitFor(() =>
      expect(seenOf(result.current, 'asset:old').extra).toEqual({
        label: RETIRED_PICTURE_LABEL,
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
      expect(seenOf(result.current, 'asset:deep').extra?.image).toEqual({
        href: 'blob:asset:deep',
      }),
    )
  })

  it('asks for no picture when the host supplies no loader', async () => {
    const { result } = renderHook(() =>
      useReferenceSeams({ body: '![](asset:pic)', load: async () => undefined }),
    )
    await waitFor(() => expect(result.current.resolveAlias('asset:pic')).toBeNull())
    expect(seenOf(result.current, 'asset:pic').extra).toBeUndefined()
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
      expect(seenOf(result.current, B).record).toBeDefined()
    })
    expect(seenOf(result.current, B).record).toEqual({ documentId: B, canvas, name: 'Board' })
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
      expect(seenOf(result.current, C).record).toBeDefined()
    })
    expect(seenOf(result.current, C).record?.body).toBe('leaf body')
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
      expect(seenOf(result.current, 'notes/named').record).toBeDefined()
    })
    expect(result.current.resolveAlias('notes/named')).toBe(B)
    expect(load).toHaveBeenCalledWith('notes/named', B)
  })

  it('titles a nameless embed from the page table, the shape the daemon keeper loads', async () => {
    // The daemon's loader returns content with no name — a document's name
    // is the workspace's — so the page's own table is the only title source.
    const load = vi.fn<ReferenceLoader>(async (_target, id) =>
      id === B ? { documentId: B, body: 'embedded body' } : undefined,
    )
    const { result } = renderHook(() =>
      useReferenceSeams({
        body: `![[${B}]]\n`,
        resolveTitle: (id) => (id === B ? 'Note B' : undefined),
        load,
      }),
    )
    await waitFor(() => {
      expect(seenOf(result.current, B).record).toBeDefined()
    })
    expect(wireSeenByCore(result.current)?.titles).toContainEqual([B, 'Note B'])
    expect(result.current.resolveTitle(B)).toBe('Note B')
  })

  it('answers a link the page table knows even when no load returned it', () => {
    const load = vi.fn<ReferenceLoader>(async () => undefined)
    const { result } = renderHook(() =>
      useReferenceSeams({
        body: 'see [[notes/other]]\n',
        resolveAlias: (alias) => (alias === 'notes/other' ? C : null),
        resolveTitle: (id) => (id === C ? 'Other note' : undefined),
        load,
      }),
    )
    expect(result.current.resolveAlias('notes/other')).toBe(C)
    expect(result.current.resolveTitle(C)).toBe('Other note')
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
    expect(seenOf(result.current, B).record ?? null).toBeNull()
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
      expect(seenOf(result.current, B).record?.body).toBe('late but wanted')
    })
    expect(load).toHaveBeenCalledTimes(1)
  })

  describe('the bundle the Rust core can be handed', () => {
    it('is a wire once nothing is in flight: the note, its picture and its link titles', async () => {
      const load = vi.fn<ReferenceLoader>(async (_target, id) =>
        id === B ? { documentId: B, body: 'embedded body', name: 'Note B' } : undefined,
      )
      const body = `![[${B}]]\n\nsee [[notes/other]] and ![shot](asset:pic)\n`
      const { result } = renderHook(() =>
        useReferenceSeams({
          body,
          resolveAlias: (alias) => (alias === 'notes/other' ? C : null),
          resolveTitle: (id) => (id === C ? 'Other note' : undefined),
          load,
          loadImage: async (ref) => `blob:${ref}`,
        }),
      )
      await waitFor(() => {
        expect(seenOf(result.current, B).record).toBeDefined()
        expect(seenOf(result.current, 'asset:pic').extra).toBeDefined()
      })
      const { asked, unaskable } = askCore(body, result.current)
      expect(unaskable).toBeUndefined()
      expect(asked).toHaveLength(1)
      const wire = asked[0]?.references as {
        entries: readonly (readonly [string, unknown])[]
        aliases: readonly (readonly [string, string])[]
        titles: readonly (readonly [string, string])[]
        extras: readonly (readonly [string, unknown])[]
      }
      expect(wire.entries.map(([key]) => key)).toEqual(expect.arrayContaining([B, 'notes/other']))
      expect(wire.aliases).toContainEqual(['notes/other', C])
      expect(wire.titles).toContainEqual([C, 'Other note'])
      expect(wire.extras).toContainEqual(['asset:pic', { image: { href: 'blob:asset:pic' } }])
      // The same answers the page's own tables gave.
      expect(result.current.resolveAlias('notes/other')).toBe(C)
      expect(result.current.resolveTitle(C)).toBe('Other note')
    })

    it('carries the page table past the loading budget, so every link resolves', async () => {
      // REFERENCE_BUDGET (256) bounds what is LOADED. Resolving a written
      // link through the page's table costs no load, so a link the walk
      // never reached still resolves and keeps its title.
      const idOf = (i: number) => `01BX5ZZKBKACTAV9WEVG${String(i).padStart(6, '0')}`
      const body = Array.from({ length: 300 }, (_, i) => `[[note-${i}]]`).join(' ')
      const load = vi.fn<ReferenceLoader>(async () => undefined)
      const { result } = renderHook(() =>
        useReferenceSeams({
          body,
          resolveAlias: (alias) =>
            alias.startsWith('note-') ? idOf(Number(alias.slice(5))) : null,
          resolveTitle: (id) => `Note ${Number(id.slice(20))}`,
          load,
        }),
      )
      await waitFor(() =>
        expect(wireSeenByCore(result.current)?.extras.some(([, extra]) => extra.pending)).toBe(
          false,
        ),
      )
      expect(load).toHaveBeenCalledTimes(256)
      const wire = askCore(body, result.current).asked[0]?.references as {
        aliases: readonly (readonly [string, string])[]
        titles: readonly (readonly [string, string])[]
      }
      expect(wire.aliases).toContainEqual(['note-0', idOf(0)])
      expect(wire.aliases).toContainEqual(['note-299', idOf(299)])
      expect(wire.titles).toContainEqual([idOf(299), 'Note 299'])
      expect(result.current.resolveAlias('note-299')).toBe(idOf(299))
    })

    it('is a wire while a load is in flight, the target still loading marked pending', () => {
      const load = vi.fn<ReferenceLoader>(() => new Promise(() => undefined))
      const { result } = renderHook(() => useReferenceSeams({ body: `![[${B}]]`, load }))
      expect(seenOf(result.current, B).extra).toEqual({ pending: true })
      const { asked, unaskable } = askCore(`![[${B}]]`, result.current)
      expect(unaskable).toBeUndefined()
      expect(asked).toHaveLength(1)
      const wire = asked[0]?.references as { extras: readonly (readonly [string, unknown])[] }
      expect(wire.extras).toContainEqual([B, { pending: true }])
    })
  })
})
