import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentThumbnail } from './DocumentThumbnail.js'

afterEach(cleanup)

const doc = { documentId: 'c1', path: 'a/b', name: 'Diagram', kind: 'spatial' as const }
const drawn = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300"><rect width="10" height="10"/></svg>',
  bounds: { x: 0, y: 0, w: 400, h: 300 },
}

function installObserver() {
  const instances: { fire: () => void }[] = []
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(cb: (e: { isIntersecting: boolean }[]) => void) {
        instances.push({ fire: () => cb([{ isIntersecting: true }]) })
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  )
  return instances
}

describe('DocumentThumbnail', () => {
  // The visibility gate is the whole reason a list of forty documents does
  // not cost forty renders: each thumbnail is a fetch of that document's
  // bytes plus a worker slot.
  it('does not render a document nobody has scrolled to', () => {
    installObserver()
    const loadRender = vi.fn(async () => drawn)
    render(<DocumentThumbnail document={doc} loadRender={loadRender} />)
    expect(loadRender).not.toHaveBeenCalled()
  })

  // The picture IS the document — not an approximation of it. This is what
  // separates a thumbnail from the box-sketch it replaces.
  it('draws the document’s own render once the row is seen', async () => {
    const observers = installObserver()
    const { getByTestId } = render(
      <DocumentThumbnail document={doc} loadRender={async () => drawn} />,
    )
    act(() => observers[0]?.fire())
    await waitFor(() => {
      const svg = getByTestId('document-thumbnail').querySelector('svg')
      expect(svg).not.toBeNull()
      expect(svg?.getAttribute('viewBox')).toBe('0 0 400 300')
    })
  })

  // Fitting is the caller's box, not the document's: a wide canvas and a
  // tall note have to land in the same square without either being cropped.
  it('lets the box size the render rather than the render size the box', async () => {
    const observers = installObserver()
    const { getByTestId } = render(
      <DocumentThumbnail document={doc} loadRender={async () => drawn} />,
    )
    act(() => observers[0]?.fire())
    await waitFor(() => {
      const svg = getByTestId('document-thumbnail').querySelector('svg')
      expect(svg?.getAttribute('width')).toBeNull()
      expect(svg?.getAttribute('height')).toBeNull()
      expect(svg?.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet')
    })
  })

  // `waitFor` is wrong for both of these: the icon is on screen from the
  // first render, so it succeeds before the load has settled and never
  // observes the state under test. Flush the promise, then assert once.
  it('keeps the kind icon when the document cannot be rendered', async () => {
    const observers = installObserver()
    const loadRender = vi.fn(async () => null)
    const { getByTestId } = render(<DocumentThumbnail document={doc} loadRender={loadRender} />)

    await act(async () => {
      observers[0]?.fire()
    })

    expect(loadRender).toHaveBeenCalled()
    expect(getByTestId('document-thumbnail').querySelector('[data-kind]')).not.toBeNull()
  })

  it('keeps the kind icon when the read throws outright', async () => {
    const observers = installObserver()
    const loadRender = vi.fn(async () => {
      throw new Error('offline')
    })
    const { getByTestId } = render(<DocumentThumbnail document={doc} loadRender={loadRender} />)

    await act(async () => {
      observers[0]?.fire()
    })

    expect(loadRender).toHaveBeenCalled()
    expect(getByTestId('document-thumbnail').querySelector('[data-kind]')).not.toBeNull()
  })

  it('is hidden from assistive technology — the row’s name already says which document it is', () => {
    installObserver()
    const { getByTestId } = render(
      <DocumentThumbnail document={doc} loadRender={async () => drawn} />,
    )
    expect(getByTestId('document-thumbnail').getAttribute('aria-hidden')).toBe('true')
  })
})
