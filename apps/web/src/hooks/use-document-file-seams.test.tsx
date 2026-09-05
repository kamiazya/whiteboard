/**
 * The backend-agnostic half of the editor's file seams. This logic used to
 * live inline in BrowserDocumentPage, which is why the daemon page shipped
 * without any of it; the caching rules below (staleness stamps, the
 * same-instance guard, URL revocation) are subtle enough that a second
 * hand-written copy is exactly what should not happen.
 */
import type { CoreFacets, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocumentFileAdapter } from '../lib/document-file-contract.js'
import { toFacetCard, useDocumentFileSeams } from './use-document-file-seams.js'

const canvasWith = (...files: string[]): SpatialCanvas => ({
  nodes: files.map((file, i) => ({
    id: `n${i}`,
    type: 'file' as const,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    file,
  })),
  edges: [],
})

const embedded = (text: string): SpatialCanvas => ({
  nodes: [{ id: 'e', type: 'text', x: 0, y: 0, width: 1, height: 1, text }],
  edges: [],
})

function makeAdapter(overrides: Partial<DocumentFileAdapter> = {}) {
  const adapter: DocumentFileAdapter = {
    isImageRef: (file) => file.startsWith('asset:'),
    loadDocument: vi.fn(async (ref: string) => ({ canvas: embedded(ref) })),
    loadImageUrl: vi.fn(async (ref: string) => `blob:${ref}`),
    storeImage: vi.fn(async () => 'asset:new'),
    ...overrides,
  }
  return adapter
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useDocumentFileSeams', () => {
  it('resolves a referenced canvas once it has been pre-fetched', async () => {
    const adapter = makeAdapter()
    const { result } = renderHook(() =>
      useDocumentFileSeams({ canvas: canvasWith('other'), adapter, stampOf: new Map() }),
    )

    // The editor's seam is synchronous, so nothing is available on the first
    // render — the point of the pre-fetch.
    expect(result.current.references.resolveReference('other')?.canvas).toBeUndefined()
    await waitFor(() =>
      expect(result.current.references.resolveReference('other')?.canvas).toBeDefined(),
    )
    expect(result.current.references.resolveReference('other')?.canvas).toEqual(embedded('other'))
  })

  it('routes image refs to the image loader and canvas refs to the canvas loader', async () => {
    const adapter = makeAdapter()
    const { result } = renderHook(() =>
      useDocumentFileSeams({
        canvas: canvasWith('asset:pic', 'sibling'),
        adapter,
        stampOf: new Map(),
      }),
    )

    await waitFor(() =>
      expect(result.current.references.resolveReference('asset:pic')?.image).toBeDefined(),
    )
    expect(result.current.references.resolveReference('asset:pic')?.image).toEqual({
      href: 'blob:asset:pic',
    })
    expect(adapter.loadDocument).toHaveBeenCalledWith('sibling')
    expect(adapter.loadDocument).not.toHaveBeenCalledWith('asset:pic')
    expect(adapter.loadImageUrl).not.toHaveBeenCalledWith('sibling')
  })

  it('re-fetches a referenced canvas only when its stamp moves', async () => {
    const adapter = makeAdapter()
    const canvas = canvasWith('other')
    const { result, rerender } = renderHook(
      ({ stampOf }: { stampOf: ReadonlyMap<string, string> }) =>
        useDocumentFileSeams({ canvas, adapter, stampOf }),
      { initialProps: { stampOf: new Map([['other', 'v1']]) as ReadonlyMap<string, string> } },
    )
    await waitFor(() =>
      expect(result.current.references.resolveReference('other')?.canvas).toBeDefined(),
    )
    expect(adapter.loadDocument).toHaveBeenCalledTimes(1)

    // Same stamp, new map identity: a re-render must not re-fetch.
    rerender({ stampOf: new Map([['other', 'v1']]) })
    expect(adapter.loadDocument).toHaveBeenCalledTimes(1)

    // Moved stamp: the referenced canvas was edited elsewhere.
    rerender({ stampOf: new Map([['other', 'v2']]) })
    await waitFor(() => expect(adapter.loadDocument).toHaveBeenCalledTimes(2))
  })

  it('does not spin when every image load fails', async () => {
    const loadImageUrl = vi.fn(async () => undefined)
    const adapter = makeAdapter({ loadImageUrl })
    renderHook(() =>
      useDocumentFileSeams({ canvas: canvasWith('asset:gone'), adapter, stampOf: new Map() }),
    )

    // A fresh-but-equal map would re-trigger the effect and retry forever.
    // Settling at one attempt is the property; the count is the evidence.
    await waitFor(() => expect(loadImageUrl).toHaveBeenCalled())
    await new Promise((settle) => setTimeout(settle, 50))
    expect(loadImageUrl).toHaveBeenCalledTimes(1)
  })

  it('revokes every object URL it created when the page unmounts', async () => {
    const revoke = vi.fn()
    vi.stubGlobal('URL', { ...URL, revokeObjectURL: revoke, createObjectURL: () => 'blob:x' })
    const adapter = makeAdapter()
    const { result, unmount } = renderHook(() =>
      useDocumentFileSeams({ canvas: canvasWith('asset:pic'), adapter, stampOf: new Map() }),
    )
    await waitFor(() =>
      expect(result.current.references.resolveReference('asset:pic')?.image).toBeDefined(),
    )

    unmount()

    // Leaking these keeps the decoded image alive for the tab's lifetime.
    expect(revoke).toHaveBeenCalledWith('blob:asset:pic')
    vi.unstubAllGlobals()
  })

  it('delegates adding an image to the adapter', async () => {
    const adapter = makeAdapter()
    const { result } = renderHook(() =>
      useDocumentFileSeams({ canvas: canvasWith(), adapter, stampOf: new Map() }),
    )

    const file = new File(['x'], 'x.png', { type: 'image/png' })
    const ref = await result.current.onAddImage(file)

    expect(adapter.storeImage).toHaveBeenCalledWith(file)
    expect(ref).toBe('asset:new')
  })

  it('exposes the adapter image-ref predicate to the editor', () => {
    const adapter = makeAdapter()
    const { result } = renderHook(() =>
      useDocumentFileSeams({ canvas: canvasWith(), adapter, stampOf: new Map() }),
    )

    expect(result.current.isImageFileRef('asset:pic')).toBe(true)
    expect(result.current.isImageFileRef('sibling')).toBe(false)
  })
})

describe('toFacetCard', () => {
  it('heads a type-only facet set with the reference, and keeps type as a row', () => {
    // Was `title: 'note'` — the type doubled as the heading. That reads the
    // same on every card of a kind, so it identifies nothing; the reference
    // does. `type` is still a row, which is where it says something.
    expect(toFacetCard('spec-a1b2c3', { type: 'note' })).toEqual({
      title: 'spec-a1b2c3',
      rows: [{ label: 'type', value: 'note' }],
    })
  })

  it('uses the workspace name for the heading when the adapter supplies one', () => {
    expect(toFacetCard('spec-a1b2c3', { type: 'note' }, 'Spec')).toEqual({
      title: 'Spec',
      rows: [{ label: 'type', value: 'note' }],
    })
  })

  it('joins tags into one row and omits the row when there are none', () => {
    expect(toFacetCard('spec-a1b2c3', { type: 'note', tags: ['a', 'b'] })?.rows).toEqual([
      { label: 'type', value: 'note' },
      { label: 'tags', value: 'a, b' },
    ])
    expect(toFacetCard('spec-a1b2c3', { type: 'note', tags: [] })?.rows).toEqual([
      { label: 'type', value: 'note' },
    ])
  })

  it('renders the OKF description as the summary row, between type and tags', () => {
    // An embed card is a preview, which §4.1 names as one of `description`'s
    // three consumers.
    expect(
      toFacetCard('spec-a1b2c3', {
        type: 'note',
        description: 'What this document is for.',
        tags: ['a'],
      })?.rows,
    ).toEqual([
      { label: 'type', value: 'note' },
      { label: 'summary', value: 'What this document is for.' },
      { label: 'tags', value: 'a' },
    ])
  })

  it('renders no row for facets the card deliberately does not show', () => {
    // `view` selects a template; it is not content. `resource` names what the
    // document describes rather than saying anything about it. Unknown root
    // keys are preserved by the model but have no agreed presentation.
    // `readCoreFacets` returns core facets PLUS `facetsRaw`, so the extra key
    // really does arrive at runtime even though the parameter narrows it away.
    const facets = {
      type: 'note',
      view: 'example.kanban/v1',
      resource: 'https://example.com',
      facetsRaw: { owner: 'x' },
    } as CoreFacets
    const card = toFacetCard('spec-a1b2c3', facets)
    expect(card?.rows).toEqual([{ label: 'type', value: 'note' }])
  })

  it('has no card for a document with no readable facets', () => {
    expect(toFacetCard('spec-a1b2c3', undefined)).toBeUndefined()
  })
})

describe('useDocumentFileSeams facets', () => {
  it('resolves core facets once the document has been pre-fetched', async () => {
    const adapter = makeAdapter({
      loadDocument: vi.fn(async (ref: string) => ({
        canvas: embedded(ref),
        facets: { type: 'note', tags: ['x'] },
        name: 'Spec',
      })),
    })
    const { result } = renderHook(() =>
      useDocumentFileSeams({ canvas: canvasWith('other'), adapter, stampOf: new Map() }),
    )

    expect(result.current.references.resolveReference('other')?.facets).toBeUndefined()
    await waitFor(() =>
      expect(result.current.references.resolveReference('other')?.facets).toBeDefined(),
    )
    expect(result.current.references.resolveReference('other')?.facets?.title).toBe('Spec')
  })

  it('keeps a facet-only document cached even though it has no canvas', async () => {
    const adapter = makeAdapter({
      loadDocument: vi.fn(async () => ({ facets: { type: 'note' } })),
    })
    const { result } = renderHook(() =>
      useDocumentFileSeams({ canvas: canvasWith('doc'), adapter, stampOf: new Map() }),
    )

    await waitFor(() =>
      expect(result.current.references.resolveReference('doc')?.facets).toBeDefined(),
    )
    expect(result.current.references.resolveReference('doc')?.canvas).toBeUndefined()
  })

  it('has no card for a document that loads without facets', async () => {
    const adapter = makeAdapter({
      loadDocument: vi.fn(async (ref: string) => ({ canvas: embedded(ref) })),
    })
    const { result } = renderHook(() =>
      useDocumentFileSeams({ canvas: canvasWith('other'), adapter, stampOf: new Map() }),
    )

    await waitFor(() =>
      expect(result.current.references.resolveReference('other')?.canvas).toBeDefined(),
    )
    expect(result.current.references.resolveReference('other')?.facets).toBeUndefined()
  })

  it('settles at one load for a reference that has no staleness stamp', async () => {
    // The write normalises a missing stamp to '' while the compare read the
    // raw `undefined`, so a dangling reference never matched its own recorded
    // stamp and reloaded on every render.
    const adapter = makeAdapter()
    const canvas = canvasWith('dangling')
    const { rerender } = renderHook(() =>
      useDocumentFileSeams({ canvas, adapter, stampOf: new Map() }),
    )

    await waitFor(() => expect(adapter.loadDocument).toHaveBeenCalledTimes(1))
    rerender()
    rerender()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(adapter.loadDocument).toHaveBeenCalledTimes(1)
  })

  it('settles at one load for a reference that resolves to nothing', async () => {
    // The sibling above covers a reference the adapter ANSWERS for. This is
    // the one it cannot: a deleted document, an imported ref into a store
    // that never had it. Its result is dropped from the cache, so the next
    // staleness pass finds it absent and asks again — while the drop itself
    // published a new map instance and scheduled that pass. The image loop
    // in the same hook already guards this exact shape by returning the SAME
    // instance when nothing was added; this loop did not.
    const adapter = makeAdapter({ loadDocument: vi.fn(async () => undefined) })
    const canvas = canvasWith('gone')
    renderHook(() => useDocumentFileSeams({ canvas, adapter, stampOf: new Map() }))

    await waitFor(() => expect(adapter.loadDocument).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(adapter.loadDocument).toHaveBeenCalledTimes(1)
  })
})

describe('useDocumentFileSeams empty documents', () => {
  it('has nothing to embed for a document whose canvas has no nodes', async () => {
    // A markdown document reads back this way; an empty miniature outranks
    // the facet card and shows less than it would.
    const adapter = makeAdapter({
      loadDocument: vi.fn(async () => ({
        canvas: { nodes: [], edges: [] },
        facets: { type: 'note' },
      })),
    })
    const { result } = renderHook(() =>
      useDocumentFileSeams({ canvas: canvasWith('note'), adapter, stampOf: new Map() }),
    )

    await waitFor(() =>
      expect(result.current.references.resolveReference('note')?.facets).toBeDefined(),
    )
    expect(result.current.references.resolveReference('note')?.canvas).toBeUndefined()
  })
})

describe('toFacetCard heading when the document has no stored title', () => {
  it('falls back to the reference, not to the type', () => {
    // The name moved to the workspace, so a document written through
    // wb_document_set no longer stores a `title` facet. Falling back to
    // `type` made every such card read "note" or "issue" — the same word on
    // every card, identifying nothing. The reference is the path, which is
    // the fallback this model uses everywhere a name is absent.
    expect(toFacetCard('release-plan', { type: 'note' })?.title).toBe('release-plan')
  })

  it('a name from the workspace replaces that fallback', () => {
    // Naming is the workspace's job for BOTH backends, so the name arrives
    // beside the facets rather than inside them.
    expect(toFacetCard('release-plan', { type: 'note' }, 'Release plan')?.title).toBe(
      'Release plan',
    )
  })
})
