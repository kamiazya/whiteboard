import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentThumbnail } from './DocumentThumbnail.js'
import { EMPTY_DOCUMENT } from './load-row-render.js'

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

  // A one-line note fitted inside a thumbnail box is a strip a pixel tall.
  it('fills the box from the corner for a note that is a single line', async () => {
    const observers = installObserver()
    const line = {
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="24" viewBox="0 0 600 24"><rect/></svg>',
      bounds: { x: 0, y: 0, w: 600, h: 24 },
    }
    const note = { ...doc, kind: 'markdown' as const }
    const { getByTestId } = render(
      <DocumentThumbnail document={note} loadRender={async () => line} />,
    )
    act(() => observers[0]?.fire())
    await waitFor(() => {
      const svg = getByTestId('document-thumbnail').querySelector('svg')
      expect(svg?.getAttribute('preserveAspectRatio')).toBe('xMinYMin slice')
    })
  })

  // A note is laid out at a column's width; fitted whole, two words sit in
  // the corner of a picture that is mostly the empty rest of the column.
  it('crops a note to the text it holds, not the column it was laid out in', async () => {
    const observers = installObserver()
    const short = {
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="656" height="89.6" viewBox="-8 -8 656 89.6"><rect/></svg>',
      bounds: { x: 0, y: 0, w: 174, h: 81.6 },
    }
    const note = { ...doc, kind: 'markdown' as const }
    const { getByTestId } = render(
      <DocumentThumbnail document={note} loadRender={async () => short} />,
    )
    act(() => observers[0]?.fire())
    await waitFor(() => {
      const svg = getByTestId('document-thumbnail').querySelector('svg')
      expect(svg?.getAttribute('viewBox')).toBe('-8 -8 182 89.6')
    })
  })

  it('keeps a wide canvas whole inside the box', async () => {
    const observers = installObserver()
    const wide = { ...drawn, bounds: { x: 0, y: 0, w: 1200, h: 100 } }
    const { getByTestId } = render(
      <DocumentThumbnail document={doc} loadRender={async () => wide} />,
    )
    act(() => observers[0]?.fire())
    await waitFor(() => {
      const svg = getByTestId('document-thumbnail').querySelector('svg')
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

  // A blank grey pane reads as a picture that failed to draw. The loader
  // answers EMPTY_DOCUMENT for a document with nothing in it — a blank note,
  // a board with no node — and the card says so under its kind.
  it('says a document with nothing to draw is empty', async () => {
    const observers = installObserver()
    const { getByTestId } = render(
      <DocumentThumbnail document={doc} loadRender={async () => EMPTY_DOCUMENT} />,
    )
    await act(async () => {
      observers[0]?.fire()
    })
    expect(getByTestId('document-thumbnail').textContent).toBe('Empty')
  })

  // A null answer is a document the loader could not draw, which says
  // nothing about what is in it.
  it('does not call a document it could not draw empty', async () => {
    const observers = installObserver()
    const { getByTestId } = render(
      <DocumentThumbnail document={doc} loadRender={async () => null} />,
    )
    await act(async () => {
      observers[0]?.fire()
    })
    expect(getByTestId('document-thumbnail').querySelector('[data-kind]')).not.toBeNull()
    expect(getByTestId('document-thumbnail').textContent).toBe('')
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
    // A read that failed says nothing about the document's content.
    expect(getByTestId('document-thumbnail').textContent).toBe('')
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
