import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { createRowOutlineLoader } from './load-row-outline.js'

const base = {
  daemonFetch: globalThis.fetch,
  daemonBaseUrl: 'http://127.0.0.1:3099',
  workspaceId: 'ws',
}
const spatial = { documentId: 'c1', path: 'a/b', kind: 'spatial' as const }
const markdown = { documentId: 'c2', path: 'notes', kind: 'markdown' as const }

describe('createRowOutlineLoader', () => {
  // Kind decides where the shape comes from, and reading the wrong endpoint
  // would either 404 or answer with a shape of the wrong thing.
  it('reads a spatial document’s snapshot, not its OKF', async () => {
    const getSnapshot = vi.fn(async () => new Uint8Array())
    const getOkf = vi.fn(async () => ({ markdown: '' }))
    await createRowOutlineLoader({ ...base, getSnapshot, getOkf })(spatial)
    expect(getSnapshot).toHaveBeenCalledOnce()
    expect(getOkf).not.toHaveBeenCalled()
  })

  it('reads a markdown document’s OKF, not its snapshot', async () => {
    const getSnapshot = vi.fn(async () => new Uint8Array())
    const getOkf = vi.fn(async () => ({ markdown: '' }))
    await createRowOutlineLoader({ ...base, getSnapshot, getOkf })(markdown)
    expect(getOkf).toHaveBeenCalledOnce()
    expect(getSnapshot).not.toHaveBeenCalled()
  })

  it('addresses a spatial document by path and a markdown one by id', async () => {
    const seen: string[] = []
    const load = createRowOutlineLoader({
      ...base,
      getSnapshot: async (_f, _u, _w, path) => {
        seen.push(`snapshot:${path}`)
        return new Uint8Array()
      },
      getOkf: async (_f, _u, _w, documentId) => {
        seen.push(`okf:${documentId}`)
        return { markdown: '' }
      },
    })
    await load(spatial)
    await load(markdown)
    // The path is the address a snapshot is served at; the id is what the
    // OKF read takes. Swapping them 404s.
    expect(seen).toEqual(['snapshot:a/b', 'okf:c2'])
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
      ...base,
      getSnapshot: async () => new Uint8Array(),
      getOkf: async () => ({ markdown: '# Title\n\nProse.\n' }),
      layoutMarkdown,
    })

    await expect(load(markdown)).resolves.toEqual(blocks)
    // The width is fixed rather than measured: an icon has no pane, and a
    // shape that changed with the window would differ between two screens.
    expect(widths).toEqual([640])
  })

  it('answers null when the layout refuses', async () => {
    const load = createRowOutlineLoader({
      ...base,
      getSnapshot: async () => new Uint8Array(),
      getOkf: async () => ({ markdown: '# Title\n' }),
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
      ...base,
      getSnapshot: async () => snapshot,
      getOkf: async () => ({ markdown: '' }),
    })

    const rects = await load(spatial)
    expect(rects).toHaveLength(2)
    expect(rects?.[0]).toMatchObject({ x: 0, y: 0, w: 200, h: 120 })
  })

  // A row that cannot be read keeps its kind icon; a throw here would take
  // the whole tree down with it.
  it('answers null rather than throwing when the read fails', async () => {
    const load = createRowOutlineLoader({
      ...base,
      getSnapshot: async () => {
        throw new Error('offline')
      },
      getOkf: async () => ({ markdown: '' }),
    })
    await expect(load(spatial)).resolves.toBeNull()
  })

  it('answers null rather than laying out an empty markdown document', async () => {
    const load = createRowOutlineLoader({
      ...base,
      getSnapshot: async () => new Uint8Array(),
      getOkf: async () => ({ markdown: '   \n' }),
    })
    await expect(load(markdown)).resolves.toBeNull()
  })

  it('answers null for a snapshot that is not a document', async () => {
    const load = createRowOutlineLoader({
      ...base,
      getSnapshot: async () => new Uint8Array([1, 2, 3]),
      getOkf: async () => ({ markdown: '' }),
    })
    await expect(load(spatial)).resolves.toBeNull()
  })
})
