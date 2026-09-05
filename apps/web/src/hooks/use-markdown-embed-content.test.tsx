import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useMarkdownEmbedContent } from './use-markdown-embed-content.js'

const B = '01BX5ZZKBKACTAV9WEVGEMMVRZ'
const C = '01BX5ZZKBKACTAV9WEVGEMMVS0'

describe('useMarkdownEmbedContent', () => {
  it('loads a directly embedded document and exposes it through the sync resolver', async () => {
    const load = vi.fn(async (id: string) =>
      id === B ? { body: 'embedded body', title: 'Note B' } : undefined,
    )
    const { result } = renderHook(() =>
      useMarkdownEmbedContent({ body: `before\n\n![[${B}]]\n`, load }),
    )
    await waitFor(() => {
      expect(result.current(B)).toBeDefined()
    })
    const entry = result.current(B)
    expect(entry?.title).toBe('Note B')
    expect(JSON.stringify(entry)).toContain('embedded body')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('a canvas target is exposed as a canvas entry, unparsed', async () => {
    const canvas: SpatialCanvas = {
      nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 200, height: 100, text: 'board node' }],
      edges: [],
    }
    const load = vi.fn(async (id: string) => (id === B ? { canvas, title: 'Board' } : undefined))
    const { result } = renderHook(() => useMarkdownEmbedContent({ body: `![[${B}]]\n`, load }))
    await waitFor(() => {
      expect(result.current(B)).toBeDefined()
    })
    expect(result.current(B)).toEqual({ title: 'Board', canvas })
  })

  it('follows transitive embeds so nested bodies resolve too', async () => {
    const docs: Record<string, { body: string; title?: string }> = {
      [B]: { body: `![[${C}]]\n` },
      [C]: { body: 'leaf body' },
    }
    const load = vi.fn(async (id: string) => docs[id])
    const { result } = renderHook(() => useMarkdownEmbedContent({ body: `![[${B}]]\n`, load }))
    await waitFor(() => {
      expect(result.current(C)).toBeDefined()
    })
    expect(JSON.stringify(result.current(C))).toContain('leaf body')
  })

  it('resolves aliased embeds through the injected alias resolver', async () => {
    const load = vi.fn(async (id: string) => (id === B ? { body: 'named body' } : undefined))
    const { result } = renderHook(() =>
      useMarkdownEmbedContent({
        body: '![[Named note]]\n',
        resolveAlias: (alias) => (alias === 'Named note' ? B : null),
        load,
      }),
    )
    await waitFor(() => {
      expect(result.current(B)).toBeDefined()
    })
  })

  it('a failed load resolves to undefined without retry storms', async () => {
    const load = vi.fn(async () => undefined)
    const { result } = renderHook(() => useMarkdownEmbedContent({ body: `![[${B}]]\n`, load }))
    await waitFor(() => {
      expect(load).toHaveBeenCalled()
    })
    expect(result.current(B)).toBeUndefined()
    // A re-render with the same body must not re-fire the failed load.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('a load that resolves after further typing still lands in the cache', async () => {
    // The stuck-placeholder bug: a keystroke re-runs the effect while the
    // load is in flight; the new pass skips the id as inflight, and the OLD
    // pass's result must not be dropped — nothing would ever re-fire it.
    let release: (value: { body: string } | undefined) => void = () => {}
    const gate = new Promise<{ body: string } | undefined>((resolve) => {
      release = resolve
    })
    const load = vi.fn(() => gate)
    const { result, rerender } = renderHook(
      ({ body }: { body: string }) => useMarkdownEmbedContent({ body, load }),
      { initialProps: { body: `![[${B}]]\n` } },
    )
    await waitFor(() => {
      expect(load).toHaveBeenCalledTimes(1)
    })
    // A keystroke lands while the load is still in flight.
    rerender({ body: `![[${B}]]\nx` })
    release({ body: 'late but wanted' })
    await waitFor(() => {
      expect(result.current(B)).toBeDefined()
    })
    expect(JSON.stringify(result.current(B))).toContain('late but wanted')
  })

  it('a body without embeds loads nothing', async () => {
    const load = vi.fn(async () => undefined)
    renderHook(() => useMarkdownEmbedContent({ body: 'plain [[wikiLink]] prose', load }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(load).not.toHaveBeenCalled()
  })
})
