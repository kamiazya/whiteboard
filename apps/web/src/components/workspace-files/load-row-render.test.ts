import { describe, expect, it, vi } from 'vitest'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { createRowRenderLoader, type RowRenderDeps } from './load-row-render.js'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'
const BOUNDS = { x: 0, y: 0, w: 640, h: 200 }

function deps(over: Partial<RowRenderDeps> = {}): RowRenderDeps {
  return {
    source: fakeFilesSource({ loadMarkdown: vi.fn(async () => '# Hi') }),
    theme: 'light',
    renderMarkdown: vi.fn(async () => ({ svg: SVG, bounds: BOUNDS })),
    renderSpatial: vi.fn(async () => ({ svg: SVG, bounds: BOUNDS })),
    readCanvas: vi.fn(() => ({ nodes: [], edges: [] })),
    ...over,
  }
}

describe('createRowRenderLoader', () => {
  // The picture in the row is the picture the preview draws, so both kinds
  // have to arrive as an SVG — not as boxes for one and a render for the
  // other, which is what made the two panes disagree about what a document
  // looks like.
  it('renders a markdown document from its OKF body', async () => {
    const d = deps()
    const load = createRowRenderLoader(d)

    expect(await load({ documentId: 'd1', path: 'a', kind: 'markdown' })).toEqual({
      svg: SVG,
      bounds: BOUNDS,
    })
    expect(d.source.loadMarkdown).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'd1' }),
    )
    expect(d.renderMarkdown).toHaveBeenCalledWith('# Hi', expect.any(Number))
    expect(d.source.loadSpatialSnapshot).not.toHaveBeenCalled()
  })

  it('renders a spatial document from its snapshot', async () => {
    const d = deps()
    const load = createRowRenderLoader(d)

    expect(await load({ documentId: 'd2', path: 'deep/one', kind: 'spatial' })).toEqual({
      svg: SVG,
      bounds: BOUNDS,
    })
    // The whole entry, so the source addresses it its own way — the daemon
    // by path, the local store by id.
    expect(d.source.loadSpatialSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'deep/one' }),
    )
    expect(d.renderSpatial).toHaveBeenCalledWith({ nodes: [], edges: [] }, 'light')
    expect(d.source.loadMarkdown).not.toHaveBeenCalled()
  })

  it('carries the theme, so a dark row is not drawn in light ink', async () => {
    const d = deps({ theme: 'dark' })
    await createRowRenderLoader(d)({ documentId: 'd2', path: 'a', kind: 'spatial' })
    expect(d.renderSpatial).toHaveBeenCalledWith(expect.anything(), 'dark')
  })

  // An empty body lays out to nothing; asking the pool for it spends a slot
  // to produce a blank picture.
  it('answers null for an empty body without touching the pool', async () => {
    const d = deps({ source: fakeFilesSource({ loadMarkdown: async () => '   \n  ' }) })
    expect(
      await createRowRenderLoader(d)({ documentId: 'd1', path: 'a', kind: 'markdown' }),
    ).toBeNull()
    expect(d.renderMarkdown).not.toHaveBeenCalled()
  })

  // Total by contract: a row that cannot draw keeps its kind icon, and a
  // list of forty rows must not be brought down by one unreadable document.
  it('answers null when the read throws', async () => {
    const d = deps({
      source: fakeFilesSource({
        loadMarkdown: async () => {
          throw new Error('403')
        },
      }),
    })
    expect(
      await createRowRenderLoader(d)({ documentId: 'd1', path: 'a', kind: 'markdown' }),
    ).toBeNull()
  })

  it('answers null when the render refuses', async () => {
    const d = deps({ renderMarkdown: vi.fn(async () => null) })
    expect(
      await createRowRenderLoader(d)({ documentId: 'd1', path: 'a', kind: 'markdown' }),
    ).toBeNull()
  })

  it('answers null when the snapshot will not decode', async () => {
    const d = deps({
      readCanvas: vi.fn(() => {
        throw new Error('corrupt')
      }),
    })
    expect(
      await createRowRenderLoader(d)({ documentId: 'd2', path: 'a', kind: 'spatial' }),
    ).toBeNull()
  })
})
