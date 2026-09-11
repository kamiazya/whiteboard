import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createInTabRenderBroker } from '../../lib/render-broker.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { createRowRenderLoader, type RowRenderDeps } from './load-row-render.js'

// Hoisted, because the loader imports both of these modules at collection
// time — a plain `const` would still be in its temporal dead zone when the
// mock factory runs.
const fonts = vi.hoisted(() => ({
  loadThemeFontFromSource: vi.fn(async (_family: string) => true),
  facesKey: { value: '' },
}))
vi.mock('../../lib/theme-fonts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/theme-fonts.js')>()),
  loadThemeFontFromSource: (family: string) => fonts.loadThemeFontFromSource(family),
  themeFacesKey: () => fonts.facesKey.value,
}))

const pool = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../../lib/layout-worker-pool.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/layout-worker-pool.js')>()),
  sharedLayoutWorkerPool: () => pool,
}))

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'
const BOUNDS = { x: 0, y: 0, w: 640, h: 200 }

function deps(over: Partial<RowRenderDeps> = {}): RowRenderDeps {
  return {
    source: fakeFilesSource({ loadMarkdown: vi.fn(async () => ({ body: '# Hi' })) }),
    theme: 'light',
    // A fresh broker per case, so one case's memo cannot answer another's.
    broker: createInTabRenderBroker(),
    renderMarkdown: vi.fn(async () => ({ svg: SVG, bounds: BOUNDS })),
    renderSpatial: vi.fn(async () => ({ svg: SVG, bounds: BOUNDS })),
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
    const entry = {
      documentId: 'd1',
      path: 'a',
      kind: 'markdown' as const,
      contentDigest: 'c0ffee0000000001',
    }

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
    // Carries a content digest, so the two renders below are separated by the
    // THEME axis rather than by a state-less key refusing to be remembered.
    const entry = { documentId: 'k1', path: 'k', contentDigest: 'c0ffee0000000002' }

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
    // Both carry a content digest: without one nothing is remembered at all
    // (see isMemoisableKey), and the axis under test here is the THEME.
    const stamped = { contentDigest: 'c0ffee0000000003' }
    const note = { documentId: 'n1', path: 'n', kind: 'markdown' as const, ...stamped }
    const board = { documentId: 'b1', path: 'b', kind: 'spatial' as const, ...stamped }

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
    expect(d.renderMarkdown).toHaveBeenCalledWith('# Hi', expect.any(Number), undefined)
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
    expect(d.renderSpatial).toHaveBeenCalledWith(expect.any(Uint8Array), 'light', undefined)
    expect(d.source.loadMarkdown).not.toHaveBeenCalled()
  })

  it('carries the theme, so a dark row is not drawn in light ink', async () => {
    const d = deps({ theme: 'dark' })
    await createRowRenderLoader(d)({ documentId: 'd2', path: 'a', kind: 'spatial' })
    expect(d.renderSpatial).toHaveBeenCalledWith(expect.anything(), 'dark', undefined)
  })

  // An empty body lays out to nothing; asking the pool for it spends a slot
  // to produce a blank picture.
  it('answers null for an empty body without touching the pool', async () => {
    const d = deps({ source: fakeFilesSource({ loadMarkdown: async () => ({ body: '   \n  ' }) }) })
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

  // The decode moved into the worker, so a corrupt snapshot now arrives as a
  // refused render rather than a throw on this thread. The row's answer is
  // the same either way, which is the point of the move being invisible here;
  // that the WORKER survives it is `layout-worker-snapshot.browser.test.tsx`.
  it('answers null when the render refuses a snapshot it could not decode', async () => {
    const d = deps({ renderSpatial: vi.fn(async () => null) })
    expect(
      await createRowRenderLoader(d)({ documentId: 'd2', path: 'a', kind: 'spatial' }),
    ).toBeNull()
  })

  // The bytes go to the worker untouched: nothing on this thread decodes
  // them, which is the whole saving.
  it('hands the stored snapshot to the renderer without decoding it here', async () => {
    const snapshot = new Uint8Array([9, 8, 7])
    const d = deps({
      source: fakeFilesSource({ loadSpatialSnapshot: async () => snapshot }),
    })
    await createRowRenderLoader(d)({ documentId: 'd2', path: 'a', kind: 'spatial' })
    expect(d.renderSpatial).toHaveBeenCalledWith(snapshot, 'light', undefined)
  })
  // The persistent tier's gate, at the only place that decides it. A row whose
  // keeper reports its content can be remembered on disk; one without must not,
  // because a re-read produces the identical key and the entry would answer
  // for a document that has since changed — for as long as the file lives,
  // which unlike the in-memory map is past the end of the tab.
  it('passes a cache key only for a row whose keeper reports its content', async () => {
    const stamped = deps()
    await createRowRenderLoader(stamped)({
      documentId: 'd3',
      path: 'a',
      kind: 'markdown',
      contentDigest: 'c0ffee0000000004',
    })
    const key = vi.mocked(stamped.renderMarkdown)?.mock.calls[0]?.[2]
    expect(typeof key).toBe('string')
    // The render key's own path, so the file on disk is addressed by the same
    // identity the in-memory map uses rather than a second spelling of it.
    expect(key).toContain('/svg/markdown/')
    expect(key).toContain('.json')

    const unstamped = deps()
    await createRowRenderLoader(unstamped)({ documentId: 'd4', path: 'b', kind: 'markdown' })
    expect(vi.mocked(unstamped.renderMarkdown)?.mock.calls[0]?.[2]).toBeUndefined()
  })
  // The identity a row is keyed by is its CONTENT, not the last write's
  // clock. Measured in loro-adapter: after a merge a replica's content took
  // on a state nobody wrote while its `updatedAt` stayed put — so two rows
  // with one stamp can be two different pictures, and two stamps can be one.
  it('keys a row by its content digest, and not by its timestamp', async () => {
    const d = deps()
    const load = createRowRenderLoader(d)
    const at = { path: 'a', kind: 'markdown' as const, updatedAt: '2026-09-03T00:00:00Z' }

    // Same stamp, different content: two pictures, two renders.
    await load({ documentId: 'd1', ...at, contentDigest: 'aaaaaaaaaaaaaaaa' })
    await load({ documentId: 'd1', ...at, contentDigest: 'bbbbbbbbbbbbbbbb' })
    expect(d.renderMarkdown).toHaveBeenCalledTimes(2)

    // Same content, a later stamp: one picture, answered from the memo.
    await load({
      documentId: 'd1',
      ...at,
      updatedAt: '2026-09-04T00:00:00Z',
      contentDigest: 'bbbbbbbbbbbbbbbb',
    })
    expect(d.renderMarkdown).toHaveBeenCalledTimes(2)
  })
})

// A list surface holds only the stored bytes, so the WORKER is the first
// realm to know which family a board's theme names. It reports the one it
// could not measure, and the fetch happens back here, on the thread that
// owns the face set — the same face the editor asks for, through the same
// in-flight map.
describe('the theme face a row needs', () => {
  beforeEach(() => {
    pool.run.mockReset()
    fonts.loadThemeFontFromSource.mockClear()
    fonts.facesKey.value = ''
  })

  const board = { documentId: 'd9', path: 'board', kind: 'spatial' as const }

  it('asks for the family the worker could not measure', async () => {
    pool.run.mockResolvedValue({
      type: 'laid-out',
      id: 1,
      svg: SVG,
      bounds: BOUNDS,
      fontsMissing: ['Yomogi'],
    })

    await createRowRenderLoader({
      source: fakeFilesSource(),
      theme: 'light',
      broker: createInTabRenderBroker(),
    })(board)

    expect(fonts.loadThemeFontFromSource).toHaveBeenCalledTimes(1)
    expect(fonts.loadThemeFontFromSource).toHaveBeenCalledWith('Yomogi')
  })

  // The fetch is on USE: a folder of boards that name no theme costs no
  // font request at all, which is what keeps this off the startup path.
  it('asks for nothing when the worker measured everything the board wanted', async () => {
    pool.run.mockResolvedValue({ type: 'laid-out', id: 1, svg: SVG, bounds: BOUNDS })

    await createRowRenderLoader({
      source: fakeFilesSource(),
      theme: 'light',
      broker: createInTabRenderBroker(),
    })(board)

    expect(fonts.loadThemeFontFromSource).not.toHaveBeenCalled()
  })

  // The picture a row holds was drawn with whatever faces this realm could
  // measure at the time, so the faces are part of what identifies it.
  // Without the axis the memo — and the worker's own store behind it —
  // keeps answering with the bundled-family picture for the life of the tab.
  it('draws a spatial row again once a face has landed, and leaves a markdown row alone', async () => {
    const broker = createInTabRenderBroker()
    const stamped = { contentDigest: 'c0ffee0000000009' }
    const note = { documentId: 'n9', path: 'n', kind: 'markdown' as const, ...stamped }
    const themed = { ...board, ...stamped }

    const before = deps({ broker })
    await createRowRenderLoader(before)(note)
    await createRowRenderLoader(before)(themed)

    fonts.facesKey.value = 'Yomogi'
    const after = deps({ broker })
    await createRowRenderLoader(after)(note)
    await createRowRenderLoader(after)(themed)

    expect(after.renderSpatial).toHaveBeenCalledTimes(1)
    // Markdown is measured in the bundled family whatever a theme names, so
    // its picture survives a face landing — the same asymmetry the theme
    // axis already has.
    expect(after.renderMarkdown).not.toHaveBeenCalled()
  })
})
