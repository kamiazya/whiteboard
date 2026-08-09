/**
 * The backend-agnostic half of the editor's file seams. This logic used to
 * live inline in BrowserLocalCanvasPage, which is why the daemon page shipped
 * without any of it; the caching rules below (staleness stamps, the
 * same-instance guard, URL revocation) are subtle enough that a second
 * hand-written copy is exactly what should not happen.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type CanvasFileAdapter, useCanvasFileSeams } from './use-canvas-file-seams.js'

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

function makeAdapter(overrides: Partial<CanvasFileAdapter> = {}) {
  const adapter: CanvasFileAdapter = {
    isImageRef: (file) => file.startsWith('asset:'),
    loadCanvas: vi.fn(async (ref: string) => embedded(ref)),
    loadImageUrl: vi.fn(async (ref: string) => `blob:${ref}`),
    storeImage: vi.fn(async () => 'asset:new'),
    ...overrides,
  }
  return adapter
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useCanvasFileSeams', () => {
  it('resolves a referenced canvas once it has been pre-fetched', async () => {
    const adapter = makeAdapter()
    const { result } = renderHook(() =>
      useCanvasFileSeams({ canvas: canvasWith('other'), adapter, stampOf: new Map() }),
    )

    // The editor's seam is synchronous, so nothing is available on the first
    // render — the point of the pre-fetch.
    expect(result.current.resolveFileCanvas('other')).toBeUndefined()
    await waitFor(() => expect(result.current.resolveFileCanvas('other')).toBeDefined())
    expect(result.current.resolveFileCanvas('other')).toEqual(embedded('other'))
  })

  it('routes image refs to the image loader and canvas refs to the canvas loader', async () => {
    const adapter = makeAdapter()
    const { result } = renderHook(() =>
      useCanvasFileSeams({
        canvas: canvasWith('asset:pic', 'sibling'),
        adapter,
        stampOf: new Map(),
      }),
    )

    await waitFor(() => expect(result.current.resolveFileImage('asset:pic')).toBeDefined())
    expect(result.current.resolveFileImage('asset:pic')).toEqual({ href: 'blob:asset:pic' })
    expect(adapter.loadCanvas).toHaveBeenCalledWith('sibling')
    expect(adapter.loadCanvas).not.toHaveBeenCalledWith('asset:pic')
    expect(adapter.loadImageUrl).not.toHaveBeenCalledWith('sibling')
  })

  it('re-fetches a referenced canvas only when its stamp moves', async () => {
    const adapter = makeAdapter()
    const canvas = canvasWith('other')
    const { result, rerender } = renderHook(
      ({ stampOf }: { stampOf: ReadonlyMap<string, string> }) =>
        useCanvasFileSeams({ canvas, adapter, stampOf }),
      { initialProps: { stampOf: new Map([['other', 'v1']]) as ReadonlyMap<string, string> } },
    )
    await waitFor(() => expect(result.current.resolveFileCanvas('other')).toBeDefined())
    expect(adapter.loadCanvas).toHaveBeenCalledTimes(1)

    // Same stamp, new map identity: a re-render must not re-fetch.
    rerender({ stampOf: new Map([['other', 'v1']]) })
    expect(adapter.loadCanvas).toHaveBeenCalledTimes(1)

    // Moved stamp: the referenced canvas was edited elsewhere.
    rerender({ stampOf: new Map([['other', 'v2']]) })
    await waitFor(() => expect(adapter.loadCanvas).toHaveBeenCalledTimes(2))
  })

  it('does not spin when every image load fails', async () => {
    const loadImageUrl = vi.fn(async () => undefined)
    const adapter = makeAdapter({ loadImageUrl })
    renderHook(() =>
      useCanvasFileSeams({ canvas: canvasWith('asset:gone'), adapter, stampOf: new Map() }),
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
      useCanvasFileSeams({ canvas: canvasWith('asset:pic'), adapter, stampOf: new Map() }),
    )
    await waitFor(() => expect(result.current.resolveFileImage('asset:pic')).toBeDefined())

    unmount()

    // Leaking these keeps the decoded image alive for the tab's lifetime.
    expect(revoke).toHaveBeenCalledWith('blob:asset:pic')
    vi.unstubAllGlobals()
  })

  it('delegates adding an image to the adapter', async () => {
    const adapter = makeAdapter()
    const { result } = renderHook(() =>
      useCanvasFileSeams({ canvas: canvasWith(), adapter, stampOf: new Map() }),
    )

    const file = new File(['x'], 'x.png', { type: 'image/png' })
    const ref = await result.current.onAddImage(file)

    expect(adapter.storeImage).toHaveBeenCalledWith(file)
    expect(ref).toBe('asset:new')
  })

  it('exposes the adapter image-ref predicate to the editor', () => {
    const adapter = makeAdapter()
    const { result } = renderHook(() =>
      useCanvasFileSeams({ canvas: canvasWith(), adapter, stampOf: new Map() }),
    )

    expect(result.current.isImageFileRef('asset:pic')).toBe(true)
    expect(result.current.isImageFileRef('sibling')).toBe(false)
  })
})
