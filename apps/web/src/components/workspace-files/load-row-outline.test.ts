// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createInTabRenderBroker } from '../../lib/render-broker.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { createRowOutlineLoader, type RowOutlineDeps } from './load-row-outline.js'

const spatial = { documentId: 'c1', path: 'a/b', kind: 'spatial' as const }
const markdown = { documentId: 'c2', path: 'notes', kind: 'markdown' as const }

const RECTS = [{ x: 0, y: 0, w: 200, h: 120 }]
const OUTLINE = { rects: RECTS }

/** A fresh broker per case, so one case's memo cannot answer another's. */
function deps(over: Partial<RowOutlineDeps> = {}): RowOutlineDeps {
  return {
    source: fakeFilesSource(),
    broker: createInTabRenderBroker(),
    outlineMarkdown: vi.fn(async () => OUTLINE),
    outlineSpatial: vi.fn(async () => OUTLINE),
    ...over,
  }
}

describe('createRowOutlineLoader', () => {
  // Kind decides where the shape comes from, and reading the wrong endpoint
  // would either 404 or answer with a shape of the wrong thing.
  it('reads a spatial document’s snapshot, not its OKF', async () => {
    const d = deps()
    await createRowOutlineLoader(d)(spatial)
    expect(d.source.loadSpatialSnapshot).toHaveBeenCalledOnce()
    expect(d.source.loadMarkdown).not.toHaveBeenCalled()
  })

  it('reads a markdown document’s OKF, not its snapshot', async () => {
    const d = deps()
    await createRowOutlineLoader(d)(markdown)
    expect(d.source.loadMarkdown).toHaveBeenCalledOnce()
    expect(d.source.loadSpatialSnapshot).not.toHaveBeenCalled()
  })

  it('hands each read the whole entry, so the source can address either way', async () => {
    // The daemon serves a snapshot at the PATH and OKF by the ID; the local
    // store keys everything by id. Passing the entry — not one field chosen
    // here — is what lets each source pick its own address, which is the
    // decision this loader used to make for them and got to be daemon-only by
    // making.
    const d = deps()
    const load = createRowOutlineLoader(d)
    await load(spatial)
    await load(markdown)
    expect(d.source.loadSpatialSnapshot).toHaveBeenCalledWith(spatial)
    expect(d.source.loadMarkdown).toHaveBeenCalledWith(markdown)
  })

  // The branch that actually produces a miniature. Every other test here
  // feeds an empty body or a failing read, so none of them reached it — a
  // mutation replacing this branch with `return null` left the suite green.
  it('lays a markdown body out and answers its blocks', async () => {
    const blocks = [
      { x: 0, y: 0, w: 300, h: 32 },
      { x: 0, y: 40, w: 460, h: 48 },
    ]
    const widths: number[] = []
    const outlineMarkdown = async (_body: string, maxWidth: number) => {
      widths.push(maxWidth)
      return { rects: blocks }
    }
    const load = createRowOutlineLoader(
      deps({
        source: fakeFilesSource({ loadMarkdown: async () => ({ body: '# Title\n\nProse.\n' }) }),
        outlineMarkdown,
      }),
    )

    await expect(load(markdown)).resolves.toEqual({ rects: blocks })
    // The width is fixed rather than measured: an icon has no pane, and a
    // shape that changed with the window would differ between two screens.
    expect(widths).toEqual([640])
  })

  it('answers null when the layout refuses', async () => {
    const load = createRowOutlineLoader(
      deps({
        source: fakeFilesSource({ loadMarkdown: async () => ({ body: '# Title\n' }) }),
        outlineMarkdown: async () => null,
      }),
    )
    await expect(load(markdown)).resolves.toBeNull()
  })

  // The bytes go to the worker untouched: nothing on this thread decodes
  // them, which is the whole saving. That the WORKER reads a real snapshot
  // correctly is `layout-worker-outline.browser.test.tsx`, where a real one
  // can be decoded by the code that actually does it.
  it('hands the stored snapshot to the outliner without decoding it here', async () => {
    const snapshot = new Uint8Array([9, 8, 7])
    const d = deps({ source: fakeFilesSource({ loadSpatialSnapshot: async () => snapshot }) })

    await expect(createRowOutlineLoader(d)(spatial)).resolves.toEqual(OUTLINE)
    expect(d.outlineSpatial).toHaveBeenCalledWith(snapshot, undefined)
  })

  // A corrupt snapshot now arrives as a refused outline rather than a throw
  // on this thread — the row's answer is the same either way, which is the
  // point of the move being invisible here.
  it('answers null when the outliner refuses a snapshot it could not decode', async () => {
    const load = createRowOutlineLoader(deps({ outlineSpatial: async () => null }))
    await expect(load(spatial)).resolves.toBeNull()
  })

  // A row that cannot be read keeps its kind icon; a throw here would take
  // the whole tree down with it.
  it('answers null rather than throwing when the read fails', async () => {
    const load = createRowOutlineLoader(
      deps({
        source: fakeFilesSource({
          loadSpatialSnapshot: async () => {
            throw new Error('offline')
          },
        }),
      }),
    )
    await expect(load(spatial)).resolves.toBeNull()
  })

  it('answers null rather than laying out an empty markdown document', async () => {
    const d = deps({ source: fakeFilesSource({ loadMarkdown: async () => ({ body: '   \n' }) }) })
    await expect(createRowOutlineLoader(d)(markdown)).resolves.toBeNull()
    expect(d.outlineMarkdown).not.toHaveBeenCalled()
  })

  // The measured defect the broker is here for: a row that scrolls away and
  // back, or a tree left and returned to, used to re-read and re-outline what
  // it already had. Both loaders below are separate instances, as two mounts
  // would be, sharing the one broker a page holds.
  it('outlines one document once, however many mounts ask', async () => {
    const broker = createInTabRenderBroker()
    const stamped = { ...markdown, contentDigest: 'c0ffee0000000005' }
    const first = deps({
      broker,
      source: fakeFilesSource({ loadMarkdown: async () => ({ body: '# Hi' }) }),
    })
    const second = deps({
      broker,
      source: fakeFilesSource({ loadMarkdown: async () => ({ body: '# Hi' }) }),
    })

    await createRowOutlineLoader(first)(stamped)
    await createRowOutlineLoader(second)(stamped)

    expect(first.outlineMarkdown).toHaveBeenCalledTimes(1)
    expect(second.outlineMarkdown).not.toHaveBeenCalled()
    expect(second.source.loadMarkdown).not.toHaveBeenCalled()
  })
})

// A spatial document's mark rides back from the worker, because that is where
// its canvas is decoded. A markdown document's is in the frontmatter the same
// read already carried, so it is joined on here — which is the only reason
// this branch differs from the one above it.
describe('a markdown document’s own mark', () => {
  const PIN = { 'visual.symbol/v0': { kind: 'emoji', char: '📌' } } as const

  it('rides the outline of the body it was read with', async () => {
    const d = deps({
      source: fakeFilesSource({ loadMarkdown: async () => ({ body: '# Title', facets: PIN }) }),
    })

    await expect(createRowOutlineLoader(d)(markdown)).resolves.toEqual({
      ...OUTLINE,
      symbol: { kind: 'emoji', char: '📌' },
    })
    // ...and reading it cost no second read of the document.
    expect(d.source.loadMarkdown).toHaveBeenCalledOnce()
  })

  // The one case where a markdown document has something to draw and no
  // shape to draw it from. Answering null here — which is what an empty body
  // did before — is a row showing a bare kind icon for a document somebody
  // deliberately marked.
  it('answers on its own for a document marked but not yet written', async () => {
    const d = deps({
      source: fakeFilesSource({ loadMarkdown: async () => ({ body: '  \n', facets: PIN }) }),
    })

    await expect(createRowOutlineLoader(d)(markdown)).resolves.toEqual({
      rects: [],
      symbol: { kind: 'emoji', char: '📌' },
    })
    expect(d.outlineMarkdown).not.toHaveBeenCalled()
  })

  // An unresolvable payload is no symbol, never a different fallback — the
  // rule `resolveDocumentSymbol` holds for every surface.
  it('leaves the outline alone when the facet does not resolve', async () => {
    const d = deps({
      source: fakeFilesSource({
        loadMarkdown: async () => ({ body: '# Title', facets: { 'visual.symbol/v0': {} } }),
      }),
    })

    await expect(createRowOutlineLoader(d)(markdown)).resolves.toEqual(OUTLINE)
  })
})
