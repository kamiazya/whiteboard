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
