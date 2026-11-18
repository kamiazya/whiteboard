import {
  constantRatioMeasureText,
  createSpatialTheme,
  layoutSpatialCanvas,
  type ReferenceWire,
  referenceSeamsFromWire,
} from '@kamiazya/whiteboard-canvas-render'
import { testLayoutCore } from '@kamiazya/whiteboard-canvas-render/test-utils/node-core'
/**
 * The editor's markdown-body seam: a file node pointing at a markdown
 * document in the same workspace renders that document's prose, instead of
 * the facet card that only says what the document IS.
 *
 * The hook hands the layout the loaded record, body raw; the layout core
 * decides what a record draws as, so these draw the wire through it.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DocumentFileAdapter } from '../lib/document-file-contract.js'
import { useDocumentFileSeams } from './use-document-file-seams.js'

type Mounted = { current: { references: ReferenceWire } }

/** The record the hook loaded for a reference, as the layout core is handed it. */
const recordOf = (result: Mounted, ref: string) =>
  new Map(result.current.references.entries).get(ref)

/** What the core draws for the canvas over the hook's wire, as JSON. */
const drawn = (result: Mounted, canvas: SpatialCanvas): string =>
  JSON.stringify(
    layoutSpatialCanvas(canvas, {
      core: testLayoutCore(),
      measure: constantRatioMeasureText,
      appearance: createSpatialTheme({ mode: 'light' }),
      expandFileNode: () => true,
      references: referenceSeamsFromWire(result.current.references),
    }),
  )

const BODY = '# Weekly notes\n\nShipped the markdown file node.'

const canvasWith = (...files: string[]): SpatialCanvas => ({
  nodes: files.map((file, i) =>
    fileNode({
      id: `n${i}`,
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      file,
    }),
  ),
  edges: [],
})

function makeAdapter(overrides: Partial<DocumentFileAdapter> = {}) {
  return {
    fileScope: 'test',
    isImageRef: (file: string) => file.startsWith('asset:'),
    loadDocument: vi.fn(async () => undefined),
    loadImageUrl: vi.fn(async () => undefined),
    loadImageBlob: vi.fn(async () => undefined),
    storeImage: vi.fn(async () => ({ ok: false as const, reason: 'unused' })),
    ...overrides,
  } satisfies DocumentFileAdapter
}

function mount(canvas: SpatialCanvas, adapter: DocumentFileAdapter) {
  return renderHook(() => useDocumentFileSeams({ canvas, adapter, stampOf: new Map(), bodies: [] }))
}

describe("a loaded reference's markdown body", () => {
  it('draws a markdown document as its prose', async () => {
    const canvas = canvasWith('notes')
    const { result } = mount(
      canvas,
      makeAdapter({ loadDocument: vi.fn(async () => ({ body: BODY })) }),
    )

    await waitFor(() => expect(recordOf(result, 'notes')?.body).toBe(BODY))
    const scene = drawn(result, canvas)
    expect(scene).toContain('Weekly notes')
    expect(scene).toContain('Shipped')
  })

  it('loads a document with no body as a record with none', async () => {
    const canvas = canvasWith('diagram')
    const { result } = mount(
      canvas,
      makeAdapter({
        loadDocument: vi.fn(async () => ({
          canvas: { nodes: [], edges: [] } as SpatialCanvas,
        })),
      }),
    )

    await waitFor(() => expect(recordOf(result, 'diagram')).toBeDefined())
    expect(recordOf(result, 'diagram')?.body).toBeUndefined()
    expect(drawn(result, canvas)).not.toContain('Weekly notes')
  })

  it('keeps a whitespace-only body as loaded and draws it without throwing', async () => {
    const canvas = canvasWith('empty')
    const { result } = mount(
      canvas,
      makeAdapter({ loadDocument: vi.fn(async () => ({ body: '   \n\n  ' })) }),
    )

    await waitFor(() => expect(recordOf(result, 'empty')).toBeDefined())
    expect(recordOf(result, 'empty')?.body).toBe('   \n\n  ')
    expect(() => drawn(result, canvas)).not.toThrow()
  })

  it('draws a daemon-shaped markdown document as its prose, never as its canvas', async () => {
    // A loaded record carrying both a body and a canvas with a node: the
    // canvas must not outrank the prose, or the same prose is drawn crushed
    // to thumbnail size.
    const canvas = canvasWith('notes')
    const { result } = mount(
      canvas,
      makeAdapter({
        loadDocument: vi.fn(async () => ({
          body: BODY,
          canvas: {
            nodes: [
              textNode({
                id: 'okf-body',
                x: 0,
                y: 0,
                width: 600,
                height: 400,
                text: 'CANVAS ONLY',
              }),
            ],
            edges: [],
          } as SpatialCanvas,
        })),
      }),
    )

    await waitFor(() => expect(recordOf(result, 'notes')?.body).toBe(BODY))
    const scene = drawn(result, canvas)
    expect(scene).toContain('Shipped')
    expect(scene).not.toContain('CANVAS ONLY')
  })

  it('stores a body the markdown parser rejects, leaving it to the layout', async () => {
    const canvas = canvasWith('bad')
    const { result } = mount(
      canvas,
      // A lone surrogate: valid JS string, not valid markdown source the
      // parser can be assumed to survive. Loading it must not throw.
      makeAdapter({ loadDocument: vi.fn(async () => ({ body: '\uD800' })) }),
    )

    await waitFor(() => expect(recordOf(result, 'bad')?.body).toBe('\uD800'))
  })
})
