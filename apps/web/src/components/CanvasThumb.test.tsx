import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonApiContext } from '@/contexts/DaemonApiContext'
import { assertNoSetStateInRenderWarning } from '../test-utils/no-setstate-in-render.js'
import { CanvasThumb } from './CanvasThumb.js'

afterEach(() => cleanup())

describe('CanvasThumb', () => {
  it('renders an img pointed at the latest-thumbnail route, url-encoding the slug', () => {
    const { container } = render(<CanvasThumb workspaceId="ws-1" slug="my canvas/x" />)
    const img = container.querySelector('img') as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.getAttribute('src')).toBe(
      '/api/workspaces/ws-1/canvases/my%20canvas%2Fx/latest-thumbnail',
    )
    expect(img.getAttribute('loading')).toBe('lazy')
    expect(img.getAttribute('decoding')).toBe('async')
  })

  it('swaps to the fallback icon and removes the img once loading fails', () => {
    const { container } = render(<CanvasThumb workspaceId="ws-1" slug="a" />)
    const img = container.querySelector('img') as HTMLImageElement
    fireEvent.error(img)
    expect(container.querySelector('img')).toBeNull()
  })

  it('resets the failed state and re-renders the img when slug changes on a reused instance', () => {
    const { container, rerender } = render(<CanvasThumb workspaceId="ws-1" slug="canvas-a" />)
    const imgA = container.querySelector('img') as HTMLImageElement
    fireEvent.error(imgA)
    expect(container.querySelector('img')).toBeNull()

    rerender(<CanvasThumb workspaceId="ws-1" slug="canvas-b" />)
    const imgB = container.querySelector('img') as HTMLImageElement
    expect(imgB).not.toBeNull()
    expect(imgB.getAttribute('src')).toBe('/api/workspaces/ws-1/canvases/canvas-b/latest-thumbnail')
  })

  it('applies the card wrapper classes and merges className for size="card"', () => {
    const { container } = render(
      <CanvasThumb workspaceId="ws-1" slug="a" size="card" className="extra-class" />,
    )
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.className).toContain('aspect-[16/9]')
    expect(wrapper.className).toContain('extra-class')
  })

  it('applies the dropdown wrapper classes by default', () => {
    const { container } = render(<CanvasThumb workspaceId="ws-1" slug="a" />)
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.className).toContain('h-9')
    expect(wrapper.className).toContain('w-14')
  })

  it('does not trigger a React setState-in-render warning when the guarded prevSrc reset runs on a src change', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { rerender } = render(<CanvasThumb workspaceId="ws-1" slug="canvas-a" />)
      // Changing slug changes `src`, which drives the guarded prevSrc reset
      // (CanvasThumb.tsx L37-41) during this render — the React-sanctioned
      // "adjust state during render" form, not the cross-component violation.
      rerender(<CanvasThumb workspaceId="ws-1" slug="canvas-b" />)
      assertNoSetStateInRenderWarning(errorSpy)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('fetches the thumbnail through the daemon fetch and renders a blob-backed <img> when a provider is mounted', async () => {
    const blob = new Blob(['fake-png'], { type: 'image/png' })
    const daemonFetch = vi.fn().mockResolvedValue(new Response(blob, { status: 200 }))
    const createObjectURL = vi.fn().mockReturnValue('blob:mock-url')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })
    try {
      const { container, findByRole } = render(
        <DaemonApiContext.Provider value={daemonFetch}>
          <CanvasThumb workspaceId="ws-1" slug="a" />
        </DaemonApiContext.Provider>,
      )
      const img = (await findByRole('presentation')) as HTMLImageElement
      expect(img.getAttribute('src')).toBe('blob:mock-url')
      expect(daemonFetch).toHaveBeenCalledWith('/api/workspaces/ws-1/canvases/a/latest-thumbnail')
      expect(container.querySelector('svg')).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('renders the fallback icon when the daemon fetch fails', async () => {
    const daemonFetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }))
    const { container } = render(
      <DaemonApiContext.Provider value={daemonFetch}>
        <CanvasThumb workspaceId="ws-1" slug="a" />
      </DaemonApiContext.Provider>,
    )
    await vi.waitFor(() => expect(container.querySelector('svg')).not.toBeNull())
    expect(container.querySelector('img')).toBeNull()
  })

  it('revokes the previous object URL when the slug identity changes', async () => {
    const blob = new Blob(['fake-png'], { type: 'image/png' })
    const daemonFetch = vi.fn().mockResolvedValue(new Response(blob, { status: 200 }))
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:mock-url'), revokeObjectURL })
    try {
      const { rerender, findByRole } = render(
        <DaemonApiContext.Provider value={daemonFetch}>
          <CanvasThumb workspaceId="ws-1" slug="canvas-a" />
        </DaemonApiContext.Provider>,
      )
      await findByRole('presentation')
      rerender(
        <DaemonApiContext.Provider value={daemonFetch}>
          <CanvasThumb workspaceId="ws-1" slug="canvas-b" />
        </DaemonApiContext.Provider>,
      )
      await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url'))
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
