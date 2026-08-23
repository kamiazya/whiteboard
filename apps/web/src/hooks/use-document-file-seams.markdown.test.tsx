/**
 * The editor's markdown-body seam: a file node pointing at a markdown
 * document in the same workspace renders that document's prose, instead of
 * the facet card that only says what the document IS.
 *
 * Parsing happens ONCE per loaded document rather than inside the resolver,
 * because canvas-render calls the seam during layout — on every re-layout,
 * for every file node.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { type DocumentFileAdapter, useDocumentFileSeams } from './use-document-file-seams.js'

const BODY = '# Weekly notes\n\nShipped the markdown file node.'

const canvasWith = (...files: string[]): SpatialCanvas => ({
  nodes: files.map((file, i) => ({
    id: `n${i}`,
    type: 'file' as const,
    x: 0,
    y: 0,
    width: 200,
    height: 200,
    file,
  })),
  edges: [],
})

function makeAdapter(overrides: Partial<DocumentFileAdapter> = {}) {
  return {
    isImageRef: (file: string) => file.startsWith('asset:'),
    loadDocument: vi.fn(async () => undefined),
    loadImageUrl: vi.fn(async () => undefined),
    storeImage: vi.fn(async () => undefined),
    ...overrides,
  } satisfies DocumentFileAdapter
}

function mount(canvas: SpatialCanvas, adapter: DocumentFileAdapter) {
  return renderHook(() => useDocumentFileSeams({ canvas, adapter, stampOf: new Map() }))
}

describe("a resolved reference's markdown body", () => {
  it('resolves a markdown document to its parsed body', async () => {
    const canvas = canvasWith('notes')
    const { result } = mount(
      canvas,
      makeAdapter({ loadDocument: vi.fn(async () => ({ body: BODY })) }),
    )

    await waitFor(() => expect(result.current.resolveReference('notes')?.markdown).toBeDefined())
    const root = result.current.resolveReference('notes')?.markdown
    expect(root?.type).toBe('root')
    expect(root?.children[0]).toMatchObject({ type: 'heading', depth: 1 })
  })

  it('returns undefined for a document with no body', async () => {
    const canvas = canvasWith('diagram')
    const { result } = mount(
      canvas,
      makeAdapter({
        loadDocument: vi.fn(async () => ({
          canvas: { nodes: [], edges: [] } as SpatialCanvas,
        })),
      }),
    )

    await waitFor(() => expect(result.current.resolveReference('diagram')?.canvas).toBeUndefined())
    expect(result.current.resolveReference('diagram')?.markdown).toBeUndefined()
  })

  it('returns undefined for a whitespace-only body, keeping the lower-ranked card', async () => {
    const canvas = canvasWith('empty')
    const { result } = mount(
      canvas,
      makeAdapter({ loadDocument: vi.fn(async () => ({ body: '   \n\n  ' })) }),
    )

    await waitFor(() => expect(result.current.resolveReference('empty')?.facets).toBeUndefined())
    expect(result.current.resolveReference('empty')?.markdown).toBeUndefined()
  })

  it('keeps the canvas seam quiet for a daemon-shaped markdown document', async () => {
    // Through the daemon a markdown document reads back as a canvas holding
    // its body in one text node, so the node-count guard that works
    // the browser does not fire — and the canvas seam would outrank the
    // markdown one, showing the same prose crushed to thumbnail size.
    const canvas = canvasWith('notes')
    const { result } = mount(
      canvas,
      makeAdapter({
        loadDocument: vi.fn(async () => ({
          body: BODY,
          canvas: {
            nodes: [
              {
                id: 'okf-body',
                type: 'text' as const,
                x: 0,
                y: 0,
                width: 600,
                height: 400,
                text: BODY,
              },
            ],
            edges: [],
          } as SpatialCanvas,
        })),
      }),
    )

    await waitFor(() => expect(result.current.resolveReference('notes')?.markdown).toBeDefined())
    expect(result.current.resolveReference('notes')?.canvas).toBeUndefined()
  })

  it('returns undefined for a reference that never loaded', () => {
    const { result } = mount(canvasWith('gone'), makeAdapter())
    expect(result.current.resolveReference('gone')?.markdown).toBeUndefined()
  })

  it('parses each body once, not once per resolver call', async () => {
    const canvas = canvasWith('notes')
    const { result } = mount(
      canvas,
      makeAdapter({ loadDocument: vi.fn(async () => ({ body: BODY })) }),
    )

    await waitFor(() => expect(result.current.resolveReference('notes')?.markdown).toBeDefined())
    // Referential equality is the observable form of "parsed once": a
    // resolver that parsed per call would hand back a fresh tree each time,
    // and canvas-render calls this for every file node on every re-layout.
    expect(result.current.resolveReference('notes')?.markdown).toBe(
      result.current.resolveReference('notes')?.markdown,
    )
  })

  it('survives a body the markdown parser rejects', async () => {
    const canvas = canvasWith('bad')
    const { result } = mount(
      canvas,
      // A lone surrogate: valid JS string, not valid markdown source the
      // parser can be assumed to survive. The seam must degrade, not throw.
      makeAdapter({ loadDocument: vi.fn(async () => ({ body: '\uD800' })) }),
    )

    await waitFor(() => expect(result.current.resolveReference('bad')?.canvas).toBeUndefined())
    expect(() => result.current.resolveReference('bad')?.markdown).not.toThrow()
  })
})
