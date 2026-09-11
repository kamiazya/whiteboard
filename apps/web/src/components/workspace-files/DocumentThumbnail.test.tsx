import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentThumbnail } from './DocumentThumbnail.js'

// The tab's face set, as the component reads it. Hoisted because the
// component imports the hook at collection time.
const fonts = vi.hoisted(() => {
  let generation = 0
  const subscribers = new Set<() => void>()
  return {
    subscribe: (callback: () => void) => {
      subscribers.add(callback)
      return () => subscribers.delete(callback)
    },
    generation: () => generation,
    land: () => {
      generation += 1
      for (const callback of subscribers) callback()
    },
  }
})
vi.mock('../../lib/theme-fonts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/theme-fonts.js')>()),
  subscribeThemeFonts: fonts.subscribe,
  themeFontsGeneration: fonts.generation,
}))

afterEach(cleanup)

const doc = { documentId: 'c1', path: 'a/b', name: 'Diagram', kind: 'spatial' as const }
const drawn = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300"><rect width="10" height="10"/></svg>',
  bounds: { x: 0, y: 0, w: 400, h: 300 },
}

const svgIn = (family: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><text font-family="${family}">hi</text></svg>`

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

  // The row is a picture of the document, so it has to become the picture
  // the editor draws — a board that names a theme is drawn in the bundled
  // family until this tab holds that theme's face, and must be drawn again
  // once it does. Nothing else notices: the render is already on screen.
  it('draws the row again once a theme face lands in this tab', async () => {
    const observers = installObserver()
    const loadRender = vi
      .fn(async () => drawn)
      .mockResolvedValueOnce({ ...drawn, svg: svgIn('Roboto') })
      .mockResolvedValueOnce({ ...drawn, svg: svgIn('Yomogi') })
    const { getByTestId } = render(<DocumentThumbnail document={doc} loadRender={loadRender} />)

    await act(async () => {
      observers[0]?.fire()
    })
    expect(getByTestId('document-thumbnail').innerHTML).toContain('font-family="Roboto"')

    await act(async () => {
      fonts.land()
    })

    await waitFor(() => {
      expect(getByTestId('document-thumbnail').innerHTML).toContain('font-family="Yomogi"')
    })
    expect(loadRender).toHaveBeenCalledTimes(2)
  })
})
