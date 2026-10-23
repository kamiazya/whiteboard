/**
 * useDocumentSync's exportScene, for what the saved file CARRIES: a markdown
 * document drawn from its body, and a PNG embedding the canvas source. The
 * editor-independent derivation itself is useDocumentSync.test.ts's.
 */

import { SPATIAL_LIGHT_PALETTE } from '@kamiazya/whiteboard-canvas-render'
import type { DocumentBackend } from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { CommentThread, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { act, renderHook } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The font embed stays offline; the rest of canvas-viewer is real.
vi.mock('@kamiazya/whiteboard-canvas-viewer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kamiazya/whiteboard-canvas-viewer')>()),
  withViewerFontEmbedded: vi.fn(async (svg: string) => svg),
}))

// The real rasteriser (null under jsdom), so one case can hand back a PNG.
vi.mock('../lib/rasterize-svg.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/rasterize-svg.js')>()
  return { rasterizeSvgToPng: vi.fn(actual.rasterizeSvgToPng) }
})

// Stub engines: what is pinned is that the canvas export waits for them, not MathJax.
vi.mock('../lib/markdown-fragment-renderers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/markdown-fragment-renderers.js')>()),
  FRAGMENT_ENGINES: {
    math: async () => ({ svg: '<g data-probe="export-math"/>', width: 40, height: 10 }),
    diagram: async () => undefined,
  },
}))

import { extractTextFromPng } from '../lib/png-embed.js'
import { rasterizeSvgToPng } from '../lib/rasterize-svg.js'
import { useDocumentSync } from './useDocumentSync.js'

type Handlers = Parameters<DocumentBackend['connect']>[0]

function fakeBackend(): DocumentBackend & { handlers: () => Handlers } {
  let held: Handlers | null = null
  return {
    handlers: () => held!,
    connect(handlers) {
      held = handlers
      handlers.onConnected()
    },
    disconnect() {
      held = null
    },
    pushLocalUpdate: () => Promise.resolve(),
    sendClientReady: () => {},
  }
}

async function deliver(backend: ReturnType<typeof fakeBackend>, doc: LoroDoc): Promise<void> {
  await act(async () => {
    backend.handlers().onSnapshot(doc.export({ mode: 'snapshot' }))
    await vi.runAllTimersAsync()
  })
}

const TEXT_CANVAS: SpatialCanvas = {
  nodes: [textNode({ id: 'n-a', x: 0, y: 0, width: 100, height: 50, text: 'hello' })],
  edges: [],
}

describe('useDocumentSync exportScene carries the document', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('carries the canvas source inside an exported png, under the whiteboard key', async () => {
    const backend = fakeBackend()
    const { result } = renderHook(() => useDocumentSync(backend))
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, TEXT_CANVAS)
    await deliver(backend, doc)
    // One transparent pixel: the rasteriser's answer where a real Canvas 2D exists.
    const pixel = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      ),
      (c) => c.charCodeAt(0),
    )
    vi.mocked(rasterizeSvgToPng).mockResolvedValueOnce(new Blob([pixel], { type: 'image/png' }))

    let png: Blob | null = null
    await act(async () => {
      png = await result.current.exportScene('png', { kind: 'spatial' })
    })

    const bytes = new Uint8Array(await (png as Blob | null)!.arrayBuffer())
    const source = extractTextFromPng(bytes, 'whiteboard')
    expect(source).toContain('"n-a"')
    expect(source).toContain('hello')
  })

  it('draws a markdown document from its body, not from a canvas it does not have', async () => {
    const backend = fakeBackend()
    const { result } = renderHook(() => useDocumentSync(backend))
    const doc = new LoroDoc()
    doc.getText('body').insert(0, 'Weekly notes')
    doc.commit()
    await deliver(backend, doc)

    let markdown: Blob | null = null
    let spatial: Blob | null = null
    await act(async () => {
      markdown = await result.current.exportScene('svg', { kind: 'markdown' })
      spatial = await result.current.exportScene('svg', { kind: 'spatial' })
    })

    expect(markdown).toEqual(expect.objectContaining({ type: 'image/svg+xml' }))
    expect(await (markdown as Blob | null)?.text()).toContain('Weekly')
    expect(await (spatial as Blob | null)?.text()).not.toContain('Weekly')
  })

  it("typesets a text node's math block in the saved canvas", async () => {
    const backend = fakeBackend()
    const { result } = renderHook(() => useDocumentSync(backend))
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, {
      nodes: [textNode({ id: 'n-m', x: 0, y: 0, width: 240, height: 120, text: '$$\nx^2\n$$\n' })],
      edges: [],
    })
    await deliver(backend, doc)

    let svg: Blob | null = null
    await act(async () => {
      svg = await result.current.exportScene('svg', { kind: 'spatial' })
    })

    expect(await (svg as Blob | null)?.text()).toContain('export-math')
  })

  it('fills an uncoloured tagged box with the colour the tag library declares', async () => {
    const backend = fakeBackend()
    const { result } = renderHook(() => useDocumentSync(backend))
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, {
      nodes: [
        textNode({
          id: 'n-t',
          x: 0,
          y: 0,
          width: 160,
          height: 60,
          text: 'db',
          tags: ['health:failing'],
        }),
      ],
      edges: [],
    })
    await deliver(backend, doc)
    const declared = SPATIAL_LIGHT_PALETTE.presets['1'].fill

    let plain: Blob | null = null
    let coloured: Blob | null = null
    await act(async () => {
      plain = await result.current.exportScene('svg', { kind: 'spatial' })
      coloured = await result.current.exportScene('svg', {
        kind: 'spatial',
        tagLibrary: { health: { exclusive: true, values: { failing: { color: '1' } } } },
      })
    })

    // The library is the only difference, so the declared fill is its doing.
    expect(await (plain as Blob | null)?.text()).not.toContain(`fill="${declared}"`)
    expect(await (coloured as Blob | null)?.text()).toContain(`fill="${declared}"`)
  })

  it('leaves the conversation out of a saved picture unless the with-comments format is chosen', async () => {
    const backend = fakeBackend()
    const { result } = renderHook(() => useDocumentSync(backend))
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, {
      nodes: [textNode({ id: 'n-p', x: 0, y: 0, width: 240, height: 60, text: 'ship the plan' })],
      edges: [],
    })
    await deliver(backend, doc)
    const threads: CommentThread[] = [
      {
        id: 't1',
        anchor: { kind: 'text', nodeId: 'n-p', quote: { exact: 'plan' }, start: 0, end: 1 },
        status: 'open',
        messages: [{ id: 'm1', body: 'about it' }],
      },
    ]

    let plain: Blob | null = null
    let commented: Blob | null = null
    let bare: Blob | null = null
    await act(async () => {
      plain = await result.current.exportScene('svg', { kind: 'spatial', threads })
      commented = await result.current.exportScene('svg-comments', { kind: 'spatial', threads })
      bare = await result.current.exportScene('svg', { kind: 'spatial' })
    })

    const text = async (blob: Blob | null) => (await blob?.text()) ?? ''
    expect(commented).toEqual(expect.objectContaining({ type: 'image/svg+xml' }))
    expect(await text(plain)).toBe(await text(bare))
    expect(await text(commented)).not.toBe(await text(plain))
  })
})
