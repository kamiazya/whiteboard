// @vitest-environment node
/**
 * The daemon binding of the editor's file seams. Until this existed, the
 * daemon page passed no seams at all, so canvas embeds (J5a) and image nodes
 * (J5b) silently did nothing there while working in browser mode.
 */
import {
  writeCoreFacets,
  writeDocumentKind,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { Loro } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDaemonFileAdapter } from './daemon-file-adapter.js'

const BASE = 'http://127.0.0.1:3099'
const WS = 'ws-1'
const path = 'my-canvas'

function snapshotOf(text: string): Uint8Array {
  const doc = new Loro()
  writeSpatialCanvas(doc, {
    nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 10, height: 10, text }],
    edges: [],
  })
  return doc.export({ mode: 'snapshot' })
}

/** A markdown document as the browser editor stores one. */
function markdownSnapshot(): Uint8Array {
  const doc = new Loro()
  doc.getText('body').insert(0, '# Weekly notes')
  doc.commit()
  return doc.export({ mode: 'snapshot' })
}

const FAKE_UUID = '11111111-2222-3333-4444-555555555555'
const FAKE_OBJECT_URL = 'blob:stubbed'

beforeEach(() => {
  // Patch the two members in place rather than replacing the globals: a
  // spread of `URL`/`crypto` copies no prototype methods, which silently
  // strips crypto.getRandomValues and breaks Loro's wasm several layers away
  // from anything this file is about.
  vi.spyOn(URL, 'createObjectURL').mockReturnValue(FAKE_OBJECT_URL)
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(FAKE_UUID)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createDaemonFileAdapter', () => {
  it('treats an asset: reference as an image and anything else as a canvas path', () => {
    const adapter = createDaemonFileAdapter({
      daemonFetch: vi.fn(),
      daemonBaseUrl: BASE,
      workspaceId: WS,
      path: path,
    })

    // The SAME convention browser uses, so a canvas keeps meaning the
    // same thing in both modes. A daemon path can never collide: paths match
    // /^[a-zA-Z0-9_-]+$/ and so cannot contain a colon.
    expect(adapter.isImageRef('asset:abc')).toBe(true)
    expect(adapter.isImageRef('sibling-canvas')).toBe(false)
  })

  it('fetches an image from the daemon file route, stripping the asset: prefix', async () => {
    // The route validates fileId against /^[a-zA-Z0-9_-]+$/, so the prefix
    // must not travel in the path.
    const daemonFetch = vi.fn(async () => new Response(new Blob(['12345'])))
    const adapter = createDaemonFileAdapter({
      daemonFetch,
      daemonBaseUrl: BASE,
      workspaceId: WS,
      path: path,
    })

    const url = await adapter.loadImageUrl('asset:file-abc')

    expect(daemonFetch).toHaveBeenCalledWith(`${BASE}/api/w/${WS}/document/${path}/file/file-abc`)
    expect(url).toBe(FAKE_OBJECT_URL)
  })

  it('resolves a missing image to undefined instead of throwing', async () => {
    const daemonFetch = vi.fn(async () => new Response(null, { status: 404 }))
    const adapter = createDaemonFileAdapter({
      daemonFetch,
      daemonBaseUrl: BASE,
      workspaceId: WS,
      path: path,
    })

    // Totality: a broken reference keeps the card, it never takes the page down.
    await expect(adapter.loadImageUrl('asset:gone')).resolves.toBeUndefined()
  })

  it('uploads an image and returns the reference the node should carry', async () => {
    const daemonFetch = vi.fn(async () => new Response(null, { status: 204 }))
    const adapter = createDaemonFileAdapter({
      daemonFetch,
      daemonBaseUrl: BASE,
      workspaceId: WS,
      path: path,
    })

    const file = new File(['xy'], 'x.png', { type: 'image/png' })
    const ref = await adapter.storeImage(file)

    expect(ref).toBe(`asset:${FAKE_UUID}`)
    const [url, init] = daemonFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${BASE}/api/w/${WS}/document/${path}/file/${FAKE_UUID}`)
    expect(init.method).toBe('PUT')
    // The route rejects an unrecognised Content-Type with 415, so the
    // picked file's own type has to travel.
    expect(new Headers(init.headers).get('Content-Type')).toBe('image/png')
  })

  it('reports a rejected upload as undefined rather than minting a dangling reference', async () => {
    const daemonFetch = vi.fn(async () => new Response(null, { status: 413 }))
    const adapter = createDaemonFileAdapter({
      daemonFetch,
      daemonBaseUrl: BASE,
      workspaceId: WS,
      path: path,
    })

    // Returning the ref anyway would put a node on the canvas pointing at
    // bytes the daemon never stored.
    await expect(
      adapter.storeImage(new File(['x'], 'x.png', { type: 'image/png' })),
    ).resolves.toBeUndefined()
  })

  it('loads a referenced canvas from its snapshot', async () => {
    const daemonFetch = vi.fn(async () => new Response(snapshotOf('hello') as BodyInit))
    const adapter = createDaemonFileAdapter({
      daemonFetch,
      daemonBaseUrl: BASE,
      workspaceId: WS,
      path: path,
    })

    const loaded = await adapter.loadDocument('sibling')

    expect(daemonFetch).toHaveBeenCalledWith(`${BASE}/api/w/${WS}/document/sibling/snapshot`)
    expect(loaded?.canvas?.nodes[0]).toMatchObject({ id: 'n1', text: 'hello' })
  })

  it('carries a referenced markdown document body, read from the same snapshot', async () => {
    // The body seam's real wiring: the hook parses whatever this returns, so
    // a test that only mocks `loadDocument` proves nothing about the
    // LoroDoc-to-body read that happens here.
    const daemonFetch = vi.fn(async () => new Response(markdownSnapshot() as BodyInit))
    const adapter = createDaemonFileAdapter({
      daemonFetch,
      daemonBaseUrl: BASE,
      workspaceId: WS,
      path: path,
    })

    const loaded = await adapter.loadDocument('notes')

    expect(loaded?.body).toBe('# Weekly notes')
  })

  it('omits the body for a document that has none, so the seam falls through', async () => {
    const daemonFetch = vi.fn(async () => new Response(snapshotOf('') as BodyInit))
    const adapter = createDaemonFileAdapter({
      daemonFetch,
      daemonBaseUrl: BASE,
      workspaceId: WS,
      path: path,
    })

    expect((await adapter.loadDocument('empty'))?.body).toBeUndefined()
  })

  it('reports no facets for a spatial document, whatever its content still holds', async () => {
    // A facet is OKF frontmatter and a JSON Canvas document has none
    // (ADR-0009 decision 3). A document written before that stopped being
    // true still carries a `core` map; surfacing it puts a facet card on a
    // diagram the server would refuse to write one to.
    const doc = new Loro()
    writeDocumentKind(doc, 'spatial')
    writeCoreFacets(doc, { type: 'diagram', tags: ['stale'] })
    const daemonFetch = vi.fn(
      async () => new Response(doc.export({ mode: 'snapshot' }) as BodyInit),
    )
    const adapter = createDaemonFileAdapter({
      daemonFetch,
      daemonBaseUrl: BASE,
      workspaceId: WS,
      path: path,
    })

    expect((await adapter.loadDocument('diagram'))?.facets).toBeUndefined()
  })

  it('still reports facets for a markdown document, which is what OKF frontmatter is', async () => {
    const doc = new Loro()
    writeDocumentKind(doc, 'markdown')
    writeCoreFacets(doc, { type: 'note', tags: ['ops'] })
    const daemonFetch = vi.fn(
      async () => new Response(doc.export({ mode: 'snapshot' }) as BodyInit),
    )
    const adapter = createDaemonFileAdapter({
      daemonFetch,
      daemonBaseUrl: BASE,
      workspaceId: WS,
      path: path,
    })

    expect((await adapter.loadDocument('notes'))?.facets).toEqual({
      type: 'note',
      tags: ['ops'],
    })
  })

  it('resolves an unreachable referenced canvas to undefined', async () => {
    const daemonFetch = vi.fn(async () => {
      throw new Error('network down')
    })
    const adapter = createDaemonFileAdapter({
      daemonFetch,
      daemonBaseUrl: BASE,
      workspaceId: WS,
      path: path,
    })

    await expect(adapter.loadDocument('sibling')).resolves.toBeUndefined()
  })

  it('percent-encodes a path on its way into the path', async () => {
    const daemonFetch = vi.fn(async () => new Response(null, { status: 404 }))
    const adapter = createDaemonFileAdapter({
      daemonFetch,
      daemonBaseUrl: BASE,
      workspaceId: WS,
      path: path,
    })

    await adapter.loadDocument('a b')

    expect(daemonFetch).toHaveBeenCalledWith(`${BASE}/api/w/${WS}/document/a%20b/snapshot`)
  })
})

describe('createDaemonFileAdapter — id references', () => {
  it('resolves an id reference to its CURRENT path through the injected lookup', async () => {
    const daemonFetch = vi.fn(async () => new Response(snapshotOf('hello') as BodyInit))
    const adapter = createDaemonFileAdapter({
      daemonFetch,
      daemonBaseUrl: BASE,
      workspaceId: WS,
      path: path,
      resolveRefPath: (ref) => (ref === 'nanoid-123' ? 'renamed-canvas' : undefined),
    })
    const loaded = await adapter.loadDocument('nanoid-123')
    expect(loaded).toBeDefined()
    expect(String((daemonFetch.mock.calls as unknown[][])[0]?.[0])).toContain(
      '/api/w/ws-1/document/renamed-canvas/snapshot',
    )
  })

  it('falls back to treating an unknown reference as a legacy path', async () => {
    const daemonFetch = vi.fn(async () => new Response(snapshotOf('legacy') as BodyInit))
    const adapter = createDaemonFileAdapter({
      daemonFetch,
      daemonBaseUrl: BASE,
      workspaceId: WS,
      path: path,
      resolveRefPath: () => undefined,
    })
    const loaded = await adapter.loadDocument('old-path-ref')
    expect(loaded).toBeDefined()
    expect(String((daemonFetch.mock.calls as unknown[][])[0]?.[0])).toContain(
      '/api/w/ws-1/document/old-path-ref/snapshot',
    )
  })
})
