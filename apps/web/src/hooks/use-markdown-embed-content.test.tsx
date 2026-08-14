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
      useMarkdownEmbedContent({ body: `before\n\n![[canvas:${B}]]\n`, load }),
    )
    await waitFor(() => {
      expect(result.current(B)).toBeDefined()
    })
    const entry = result.current(B)
    expect(entry?.title).toBe('Note B')
    expect(JSON.stringify(entry?.root)).toContain('embedded body')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('follows transitive embeds so nested bodies resolve too', async () => {
    const docs: Record<string, { body: string; title?: string }> = {
      [B]: { body: `![[canvas:${C}]]\n` },
      [C]: { body: 'leaf body' },
    }
    const load = vi.fn(async (id: string) => docs[id])
    const { result } = renderHook(() =>
      useMarkdownEmbedContent({ body: `![[canvas:${B}]]\n`, load }),
    )
    await waitFor(() => {
      expect(result.current(C)).toBeDefined()
    })
    expect(JSON.stringify(result.current(C)?.root)).toContain('leaf body')
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
    const { result } = renderHook(() =>
      useMarkdownEmbedContent({ body: `![[canvas:${B}]]\n`, load }),
    )
    await waitFor(() => {
      expect(load).toHaveBeenCalled()
    })
    expect(result.current(B)).toBeUndefined()
    // A re-render with the same body must not re-fire the failed load.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('a body without embeds loads nothing', async () => {
    const load = vi.fn(async () => undefined)
    renderHook(() => useMarkdownEmbedContent({ body: 'plain [[wikiLink]] prose', load }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(load).not.toHaveBeenCalled()
  })
})
