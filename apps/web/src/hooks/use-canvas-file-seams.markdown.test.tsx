/**
 * The editor's markdown-body seam: a file node pointing at a markdown
 * document in the same workspace renders that document's prose, instead of
 * the facet card that only says what the document IS.
 *
 * Parsing happens ONCE per loaded document rather than inside the resolver,
 * because canvas-render calls the seam during layout — on every re-layout,
 * for every file node.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { type CanvasFileAdapter, useCanvasFileSeams } from './use-canvas-file-seams.js'

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

function makeAdapter(overrides: Partial<CanvasFileAdapter> = {}) {
  return {
    isImageRef: (file: string) => file.startsWith('asset:'),
    loadDocument: vi.fn(async () => undefined),
    loadImageUrl: vi.fn(async () => undefined),
    storeImage: vi.fn(async () => undefined),
    ...overrides,
  } satisfies CanvasFileAdapter
}

function mount(canvas: SpatialCanvas, adapter: CanvasFileAdapter) {
  return renderHook(() => useCanvasFileSeams({ canvas, adapter, stampOf: new Map() }))
}

describe('resolveFileMarkdown', () => {
  it('resolves a markdown document to its parsed body', async () => {
    const canvas = canvasWith('notes')
    const { result } = mount(
      canvas,
      makeAdapter({ loadDocument: vi.fn(async () => ({ body: BODY })) }),
    )

    await waitFor(() => expect(result.current.resolveFileMarkdown('notes')).toBeDefined())
    const root = result.current.resolveFileMarkdown('notes')
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

    await waitFor(() => expect(result.current.resolveFileCanvas('diagram')).toBeUndefined())
    expect(result.current.resolveFileMarkdown('diagram')).toBeUndefined()
  })

  it('returns undefined for a whitespace-only body, keeping the lower-ranked card', async () => {
    const canvas = canvasWith('empty')
    const { result } = mount(
      canvas,
      makeAdapter({ loadDocument: vi.fn(async () => ({ body: '   \n\n  ' })) }),
    )

    await waitFor(() => expect(result.current.resolveFileFacets('empty')).toBeUndefined())
    expect(result.current.resolveFileMarkdown('empty')).toBeUndefined()
  })

  it('keeps the canvas seam quiet for a daemon-shaped markdown document', async () => {
    // Through the daemon a markdown document reads back as a canvas holding
    // its body in one text node, so the node-count guard that works
    // browser-local does not fire — and the canvas seam would outrank the
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

    await waitFor(() => expect(result.current.resolveFileMarkdown('notes')).toBeDefined())
    expect(result.current.resolveFileCanvas('notes')).toBeUndefined()
  })

  it('returns undefined for a reference that never loaded', () => {
    const { result } = mount(canvasWith('gone'), makeAdapter())
    expect(result.current.resolveFileMarkdown('gone')).toBeUndefined()
  })

  it('parses each body once, not once per resolver call', async () => {
    const canvas = canvasWith('notes')
    const { result } = mount(
      canvas,
      makeAdapter({ loadDocument: vi.fn(async () => ({ body: BODY })) }),
    )

    await waitFor(() => expect(result.current.resolveFileMarkdown('notes')).toBeDefined())
    // Referential equality is the observable form of "parsed once": a
    // resolver that parsed per call would hand back a fresh tree each time,
    // and canvas-render calls this for every file node on every re-layout.
    expect(result.current.resolveFileMarkdown('notes')).toBe(
      result.current.resolveFileMarkdown('notes'),
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

    await waitFor(() => expect(result.current.resolveFileCanvas('bad')).toBeUndefined())
    expect(() => result.current.resolveFileMarkdown('bad')).not.toThrow()
  })
})
