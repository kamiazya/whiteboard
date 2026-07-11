import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonApiContext } from '@/contexts/DaemonApiContext'
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

  it('renders the fallback placeholder instead of an <img> when a DaemonApiContext provider is mounted (cross-origin)', () => {
    const daemonFetch = vi.fn()
    const { container } = render(
      <DaemonApiContext.Provider value={daemonFetch}>
        <CanvasThumb workspaceId="ws-1" slug="a" />
      </DaemonApiContext.Provider>,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })
})
