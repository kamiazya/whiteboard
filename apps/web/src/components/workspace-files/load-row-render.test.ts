import { describe, expect, it, vi } from 'vitest'
import { createInTabRenderBroker } from '../../lib/render-broker.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { createRowRenderLoader, type RowRenderDeps } from './load-row-render.js'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'
const BOUNDS = { x: 0, y: 0, w: 640, h: 200 }

function deps(over: Partial<RowRenderDeps> = {}): RowRenderDeps {
  return {
    source: fakeFilesSource({ loadMarkdown: vi.fn(async () => '# Hi') }),
    theme: 'light',
    // A fresh broker per case, so one case's memo cannot answer another's.
    broker: createInTabRenderBroker(),
    renderMarkdown: vi.fn(async () => ({ svg: SVG, bounds: BOUNDS })),
    renderSpatial: vi.fn(async () => ({ svg: SVG, bounds: BOUNDS })),
    readCanvas: vi.fn(() => ({ nodes: [], edges: [] })),
    ...over,
  }
}

describe('createRowRenderLoader', () => {
  // The measured defect this loader was routed through a broker to fix: the
  // row's thumbnail and the preview pane beside it are separate components
  // asking separately, so the second arrives while the first is still in the
  // worker. Both must come back with one render behind them.
  it('renders one document once, however many surfaces ask', async () => {
    const d = deps()
    const load = createRowRenderLoader(d)
    const entry = { documentId: 'd1', path: 'a', kind: 'markdown' as const }

    const [row, preview] = await Promise.all([load(entry), load(entry)])

    expect(row).toEqual(preview)
    expect(d.renderMarkdown).toHaveBeenCalledTimes(1)
    expect(d.source.loadMarkdown).toHaveBeenCalledTimes(1)
  })

  // `kind` is optional on a row, and an entry without one is rendered
  // SPATIALLY — so its key has to carry the theme. Keying it as markdown
  // would drop that axis and let one entry answer for a light and a dark
  // render of the same board, which is the worst failure a cache can have:
  // a picture that is wrong rather than missing.
  it('keys a kind-less row the way it actually renders it — spatially, with the theme', async () => {
    const broker = createInTabRenderBroker()
    const entry = { documentId: 'k1', path: 'k' }

    const light = deps({ broker, theme: 'light' })
    await createRowRenderLoader(light)(entry)
    const dark = deps({ broker, theme: 'dark' })
    await createRowRenderLoader(dark)(entry)

    expect(light.renderSpatial).toHaveBeenCalledTimes(1)
    expect(dark.renderSpatial).toHaveBeenCalledTimes(1)
    expect(dark.renderMarkdown).not.toHaveBeenCalled()
  })

  // A theme toggle rebuilds the loader (the palette is a spatial render's
  // input) but must not rebuild a markdown picture, whose ink comes from CSS.
  it('keeps a markdown render across a theme change, and redraws a spatial one', async () => {
    const broker = createInTabRenderBroker()
    const note = { documentId: 'n1', path: 'n', kind: 'markdown' as const }
    const board = { documentId: 'b1', path: 'b', kind: 'spatial' as const }

    const light = deps({ broker, theme: 'light' })
    await createRowRenderLoader(light)(note)
    await createRowRenderLoader(light)(board)

    const dark = deps({ broker, theme: 'dark' })
    await createRowRenderLoader(dark)(note)
    await createRowRenderLoader(dark)(board)

    expect(dark.renderMarkdown).not.toHaveBeenCalled()
    expect(dark.renderSpatial).toHaveBeenCalledTimes(1)
  })

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
