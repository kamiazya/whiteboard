import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { createRowOutlineLoader } from './load-row-outline.js'

const spatial = { documentId: 'c1', path: 'a/b', kind: 'spatial' as const }
const markdown = { documentId: 'c2', path: 'notes', kind: 'markdown' as const }

describe('createRowOutlineLoader', () => {
  // Kind decides where the shape comes from, and reading the wrong endpoint
  // would either 404 or answer with a shape of the wrong thing.
  it('reads a spatial document’s snapshot, not its OKF', async () => {
    const source = fakeFilesSource()
    await createRowOutlineLoader({ source })(spatial)
    expect(source.loadSpatialSnapshot).toHaveBeenCalledOnce()
    expect(source.loadMarkdown).not.toHaveBeenCalled()
  })

  it('reads a markdown document’s OKF, not its snapshot', async () => {
    const source = fakeFilesSource()
    await createRowOutlineLoader({ source })(markdown)
    expect(source.loadMarkdown).toHaveBeenCalledOnce()
    expect(source.loadSpatialSnapshot).not.toHaveBeenCalled()
  })

  it('hands each read the whole entry, so the source can address either way', async () => {
    // The daemon serves a snapshot at the PATH and OKF by the ID; the local
    // store keys everything by id. Passing the entry — not one field chosen
    // here — is what lets each source pick its own address, which is the
    // decision this loader used to make for them and got to be daemon-only by
    // making.
    const source = fakeFilesSource()
    const load = createRowOutlineLoader({ source })
    await load(spatial)
    await load(markdown)
    expect(source.loadSpatialSnapshot).toHaveBeenCalledWith(spatial)
    expect(source.loadMarkdown).toHaveBeenCalledWith(markdown)
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
    const layoutMarkdown = async (_body: string, maxWidth: number) => {
      widths.push(maxWidth)
      return blocks
    }
    const load = createRowOutlineLoader({
      source: fakeFilesSource({ loadMarkdown: async () => '# Title\n\nProse.\n' }),
      layoutMarkdown,
    })

    await expect(load(markdown)).resolves.toEqual(blocks)
    // The width is fixed rather than measured: an icon has no pane, and a
    // shape that changed with the window would differ between two screens.
    expect(widths).toEqual([640])
  })

  it('answers null when the layout refuses', async () => {
    const load = createRowOutlineLoader({
      source: fakeFilesSource({ loadMarkdown: async () => '# Title\n' }),
      layoutMarkdown: async () => null,
    })
    await expect(load(markdown)).resolves.toBeNull()
  })

  // The spatial branch's own success path: a REAL snapshot, so the read and
  // the outline are both exercised rather than fed empty bytes.
  it('reads a spatial document’s nodes as its shape', async () => {
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, {
      nodes: [
        { id: 'a', type: 'text', x: 0, y: 0, width: 200, height: 120, text: 'one' },
        { id: 'b', type: 'text', x: 240, y: 0, width: 160, height: 90, text: 'two' },
      ],
      edges: [],
    })
    const snapshot = doc.export({ mode: 'snapshot' })

    const load = createRowOutlineLoader({
      source: fakeFilesSource({ loadSpatialSnapshot: async () => snapshot }),
    })

    const rects = await load(spatial)
    expect(rects).toHaveLength(2)
    expect(rects?.[0]).toMatchObject({ x: 0, y: 0, w: 200, h: 120 })
  })

  // A row that cannot be read keeps its kind icon; a throw here would take
  // the whole tree down with it.
  it('answers null rather than throwing when the read fails', async () => {
    const load = createRowOutlineLoader({
      source: fakeFilesSource({
        loadSpatialSnapshot: async () => {
          throw new Error('offline')
        },
      }),
    })
    await expect(load(spatial)).resolves.toBeNull()
  })

  it('answers null rather than laying out an empty markdown document', async () => {
    const load = createRowOutlineLoader({
      source: fakeFilesSource({ loadMarkdown: async () => '   \n' }),
    })
    await expect(load(markdown)).resolves.toBeNull()
  })

  it('answers null for a snapshot that is not a document', async () => {
    const load = createRowOutlineLoader({
      source: fakeFilesSource({ loadMarkdown: async () => '' }),
    })
    await expect(load(spatial)).resolves.toBeNull()
  })
})
