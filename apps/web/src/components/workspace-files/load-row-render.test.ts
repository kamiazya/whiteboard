import { describe, expect, it, vi } from 'vitest'
import { createRowRenderLoader, type RowRenderDeps } from './load-row-render.js'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'
const BOUNDS = { x: 0, y: 0, w: 640, h: 200 }

function deps(over: Partial<RowRenderDeps> = {}): RowRenderDeps {
  return {
    daemonFetch: vi.fn() as unknown as typeof globalThis.fetch,
    daemonBaseUrl: 'http://d',
    workspaceId: 'default',
    theme: 'light',
    getSnapshot: vi.fn(async () => new Uint8Array()),
    getOkf: vi.fn(async () => ({ markdown: '# Hi' })),
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
    expect(d.getOkf).toHaveBeenCalledWith(d.daemonFetch, 'http://d', 'default', 'd1')
    expect(d.renderMarkdown).toHaveBeenCalledWith('# Hi', expect.any(Number))
    expect(d.getSnapshot).not.toHaveBeenCalled()
  })

  // Spatial reads by PATH and markdown by id — two different routes, and
  // sending either one the other's key is a 404 that reads as "no picture".
  it('renders a spatial document from its snapshot, by path', async () => {
    const d = deps()
    const load = createRowRenderLoader(d)

    expect(await load({ documentId: 'd2', path: 'deep/one', kind: 'spatial' })).toEqual({
      svg: SVG,
      bounds: BOUNDS,
    })
    expect(d.getSnapshot).toHaveBeenCalledWith(d.daemonFetch, 'http://d', 'default', 'deep/one')
    expect(d.renderSpatial).toHaveBeenCalledWith({ nodes: [], edges: [] }, 'light')
    expect(d.getOkf).not.toHaveBeenCalled()
  })

  it('carries the theme, so a dark row is not drawn in light ink', async () => {
    const d = deps({ theme: 'dark' })
    await createRowRenderLoader(d)({ documentId: 'd2', path: 'a', kind: 'spatial' })
    expect(d.renderSpatial).toHaveBeenCalledWith(expect.anything(), 'dark')
  })

  // An empty body lays out to nothing; asking the pool for it spends a slot
  // to produce a blank picture.
  it('answers null for an empty body without touching the pool', async () => {
    const d = deps({ getOkf: vi.fn(async () => ({ markdown: '   \n  ' })) })
    expect(
      await createRowRenderLoader(d)({ documentId: 'd1', path: 'a', kind: 'markdown' }),
    ).toBeNull()
    expect(d.renderMarkdown).not.toHaveBeenCalled()
  })

  // Total by contract: a row that cannot draw keeps its kind icon, and a
  // list of forty rows must not be brought down by one unreadable document.
  it('answers null when the read throws', async () => {
    const d = deps({
      getOkf: vi.fn(async () => {
        throw new Error('403')
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
