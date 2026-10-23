import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSceneExport } from './useSceneExport'

/**
 * Stubs the blob URL pair and records each download's filename instead of
 * letting jsdom attempt the navigation a real anchor click would start.
 */
function stubDownloads() {
  const revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:mock-url'),
    revokeObjectURL,
  })
  const downloads: string[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push(this.download)
  })
  return { revokeObjectURL, downloads }
}

describe('useSceneExport', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('sets exportError when onExport resolves with no blob', async () => {
    const onExport = vi.fn().mockResolvedValue(null)
    const { result } = renderHook(() => useSceneExport({ onExport, filenameBase: 'my-canvas' }))
    await act(async () => {
      await result.current.handleExport('png')
    })
    expect(result.current.exportError).toBe('Export as PNG failed: no data to export.')
  })

  it('sets exportError when onExport rejects', async () => {
    const onExport = vi.fn().mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useSceneExport({ onExport, filenameBase: 'my-canvas' }))
    await act(async () => {
      await result.current.handleExport('svg')
    })
    expect(result.current.exportError).toBe('Export as SVG failed.')
  })

  // Firefox (and the HTML spec generally) does not start a download from a
  // synthetic .click() on an <a> that was never attached to the document —
  // the exact "looks like it worked but does nothing" defect this hook's
  // append/click/remove dance exists to avoid.
  it('attaches the download anchor to the document before clicking it, then removes it', async () => {
    const onExport = vi.fn().mockResolvedValue(new Blob(['fake-png'], { type: 'image/png' }))
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:mock-url'),
      revokeObjectURL: vi.fn(),
    })

    let anchorConnectedAtClick: boolean | null = null
    const anchors: HTMLAnchorElement[] = []
    const realCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string, ...rest) => {
      const el = realCreateElement(tagName, ...rest)
      if (tagName === 'a') {
        anchors.push(el as HTMLAnchorElement)
        const realClick = el.click.bind(el)
        el.click = () => {
          anchorConnectedAtClick = el.isConnected
          realClick()
        }
      }
      return el
    })

    const { result } = renderHook(() => useSceneExport({ onExport, filenameBase: 'my-canvas' }))
    await act(async () => {
      await result.current.handleExport('png')
    })

    const anchor = anchors.at(-1)
    expect(anchorConnectedAtClick).toBe(true)
    expect(anchor?.isConnected).toBe(false)
    expect(anchor?.download).toBe('my-canvas.png')
  })

  it('clears the previous failure when a retry succeeds', async () => {
    stubDownloads()
    const onExport = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(new Blob(['fake-png'], { type: 'image/png' }))
    const { result } = renderHook(() => useSceneExport({ onExport, filenameBase: 'my-canvas' }))
    await act(async () => {
      await result.current.handleExport('png')
    })
    expect(result.current.exportError).toBe('Export as PNG failed.')
    await act(async () => {
      await result.current.handleExport('png')
    })
    expect(result.current.exportError).toBeNull()
  })

  it('downloads an SVG export as .svg, then releases its blob URL', async () => {
    const { revokeObjectURL, downloads } = stubDownloads()
    const onExport = vi.fn().mockResolvedValue(new Blob(['<svg/>'], { type: 'image/svg+xml' }))
    const { result } = renderHook(() => useSceneExport({ onExport, filenameBase: 'my-canvas' }))
    await act(async () => {
      await result.current.handleExport('svg')
    })
    expect(downloads).toEqual(['my-canvas.svg'])
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url'))
  })

  it('is a no-op when onExport is undefined', async () => {
    const { result } = renderHook(() =>
      useSceneExport({ onExport: undefined, filenameBase: 'my-canvas' }),
    )
    await act(async () => {
      await result.current.handleExport('png')
    })
    expect(result.current.exportError).toBeNull()
  })

  it('says what it exported once the file has gone out, and nothing on failure', async () => {
    stubDownloads()
    const onExported = vi.fn()
    const ok = renderHook(() =>
      useSceneExport({
        onExport: vi.fn().mockResolvedValue(new Blob(['x'])),
        filenameBase: 'c',
        onExported,
      }),
    )
    const empty = renderHook(() =>
      useSceneExport({ onExport: vi.fn().mockResolvedValue(null), filenameBase: 'c', onExported }),
    )
    await act(async () => {
      await empty.result.current.handleExport('svg')
    })
    expect(onExported).not.toHaveBeenCalled()
    await act(async () => {
      await ok.result.current.handleExport('png')
    })
    expect(onExported).toHaveBeenCalledExactlyOnceWith('Exported as PNG')
  })

  it('downloads a note as .md and says it was saved as Markdown', async () => {
    const { downloads } = stubDownloads()
    const onExported = vi.fn()
    const onExport = vi.fn().mockResolvedValue(new Blob(['---\ntype: note\n---\n']))
    const { result } = renderHook(() =>
      useSceneExport({ onExport, filenameBase: 'my-note', onExported }),
    )
    await act(async () => {
      await result.current.handleExport('md')
    })
    expect(downloads).toEqual(['my-note.md'])
    expect(onExported).toHaveBeenCalledExactlyOnceWith('Saved as Markdown')
  })

  it('downloads a canvas as .canvas and says images are referenced when it names one', async () => {
    const { downloads } = stubDownloads()
    const onExported = vi.fn()
    const withImage = new Blob(['{"nodes":[{"file":"asset:abc"}]}'])
    const plain = new Blob(['{"nodes":[],"edges":[]}'])
    const onExport = vi.fn().mockResolvedValueOnce(withImage).mockResolvedValueOnce(plain)
    const { result } = renderHook(() =>
      useSceneExport({ onExport, filenameBase: 'board', onExported }),
    )
    await act(async () => {
      await result.current.handleExport('canvas')
    })
    await act(async () => {
      await result.current.handleExport('canvas')
    })
    expect(downloads).toEqual(['board.canvas', 'board.canvas'])
    expect(onExported).toHaveBeenNthCalledWith(
      1,
      'Saved as JSON Canvas — images are referenced, not embedded',
    )
    expect(onExported).toHaveBeenNthCalledWith(2, 'Saved as JSON Canvas')
  })
})
