/**
 * Nearest-layer coverage for the LOD gate and the fragment seams the seam hook owns. The browser
 * suites (canvas-embed-lod, drag-ghost-embed) pin what an expanded file
 * node RENDERS as; this file pins the gate's own decisions — hysteresis
 * and the budget — at the layer they live, where each case is a zoom
 * number instead of a mounted editor.
 */

import {
  type CanvasLayoutRequest,
  constantRatioMeasureText,
  layoutSpatialCanvasWithAnchors,
  type MeasureText,
  referenceWire,
  type SpatialLayoutOptions,
} from '@kamiazya/whiteboard-canvas-render'
import { createFixedMeasure, fakeLayoutCore } from '@kamiazya/whiteboard-canvas-render/test-utils'
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import {
  fileNode as buildFileNode,
  textNode as buildTextNode,
} from '@kamiazya/whiteboard-model/test-utils'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderCanvasToSvg } from '../../lib/spatial/scene-render.js'
import { editorLayoutBase } from '../../lib/spatial/scene-render-core.js'
import { useFileSeamScene } from './use-file-seam-scene.js'

const measure: MeasureText = () => ({ advanceWidth: 0, ascent: 0, descent: 0, lineGap: 0 })
const references = referenceWire(new Map())
const fixedMeasure = createFixedMeasure({
  advance: (text) => text.length * 6,
  ascent: 10,
  descent: 2,
})

function fileNode(id: string, width: number, height: number): SpatialNode {
  return buildFileNode({ id, file: `doc-${id}`, x: 0, y: 0, width, height })
}

function canvasOf(nodes: readonly SpatialNode[]): SpatialCanvas {
  return { nodes: [...nodes], edges: [] }
}

function renderSeam(canvas: SpatialCanvas, zoom: number) {
  return renderHook(
    ({ c, z }) =>
      useFileSeamScene({
        canvas: c,
        zoom: z,
        references,
        fileRefOptions: undefined,
        missingFileRef: undefined,
        resolvedMeasure: measure,
        theme: 'light',
      }),
    { initialProps: { c: canvas, z: zoom } },
  )
}

const expands = (result: { current: ReturnType<typeof useFileSeamScene> }, node: SpatialNode) =>
  result.current.fileSeamOptions.expandFileNode?.(node) ?? false

describe('useFileSeamScene LOD gate', () => {
  it('expands a file node only once its on-screen box reaches 200x140', async () => {
    const big = fileNode('big', 220, 150)
    const small = fileNode('small', 180, 120)
    const { result } = renderSeam(canvasOf([big, small]), 1)
    await waitFor(() => expect(expands(result, big)).toBe(true))
    expect(expands(result, small)).toBe(false)
  })

  it('keeps an expanded node until it shrinks below 160x110 (hysteresis), then collapses it', async () => {
    const node = fileNode('h', 220, 150)
    const { result, rerender } = renderSeam(canvasOf([node]), 1)
    await waitFor(() => expect(expands(result, node)).toBe(true))

    // 220x150 at zoom 0.8 is 176x120 — under the expand threshold, above
    // the collapse one. An expanded node must ride through it.
    rerender({ c: canvasOf([node]), z: 0.8 })
    await waitFor(() => expect(expands(result, node)).toBe(true))

    // At zoom 0.6 (132x90) the collapse floor is crossed.
    rerender({ c: canvasOf([node]), z: 0.6 })
    await waitFor(() => expect(expands(result, node)).toBe(false))

    // And 0.8 again does NOT re-expand: hysteresis is one-directional.
    rerender({ c: canvasOf([node]), z: 0.8 })
    await waitFor(() => expect(expands(result, node)).toBe(false))
  })

  it('caps simultaneous miniatures at the 8 largest candidates, tie-broken by id', async () => {
    const nodes = Array.from({ length: 10 }, (_, i) =>
      // n0 is largest, n9 smallest; all clear the expand threshold.
      fileNode(`n${i}`, 400 - i * 10, 300),
    )
    const { result } = renderSeam(canvasOf(nodes), 1)
    await waitFor(() => expect(expands(result, nodes[7]!)).toBe(true))
    expect(nodes.map((node) => expands(result, node))).toEqual([
      ...Array.from({ length: 8 }, () => true),
      false,
      false,
    ])
  })

  it('offers no expansion gate at all without a reference resolver', () => {
    const { result } = renderHook(() =>
      useFileSeamScene({
        canvas: canvasOf([fileNode('a', 400, 300)]),
        zoom: 1,
        references: undefined,
        fileRefOptions: undefined,
        missingFileRef: undefined,
        resolvedMeasure: measure,
        theme: 'light',
      }),
    )
    expect(result.current.fileSeamOptions.expandFileNode).toBeUndefined()
  })
})

describe('useFileSeamScene fragments', () => {
  it("typesets a text node's math block once its fragment lands, through every sync render", async () => {
    const fragment = { svg: '<g data-probe="typeset-math"/>', width: 40, height: 10 }
    const math = vi.fn(async () => fragment)
    const board = canvasOf([
      buildTextNode({ id: 't', x: 0, y: 0, width: 240, height: 120, text: '$$\nx^2\n$$\n' }),
    ])
    const { result } = renderHook(() =>
      useFileSeamScene({
        canvas: board,
        zoom: 1,
        references: undefined,
        fileRefOptions: undefined,
        missingFileRef: undefined,
        resolvedMeasure: fixedMeasure,
        theme: 'light',
        fragmentLoaders: { math, diagram: async () => undefined },
      }),
    )
    const draw = () =>
      renderCanvasToSvg(board, { measure: fixedMeasure, ...result.current.fileSeamOptions }).svg
    // The first layout draws the source and is what asks for the fragment.
    act(() => {
      expect(draw()).not.toContain('typeset-math')
    })
    await waitFor(() => expect(draw()).toContain('typeset-math'))
    expect(math).toHaveBeenCalledTimes(1)
    expect(result.current.wire.fragments).toEqual([['math:x^2', fragment]])
  })
})

describe('useFileSeamScene reference chrome', () => {
  const inner: SpatialCanvas = canvasOf([
    buildTextNode({ id: 'i', x: 0, y: 0, width: 120, height: 60, text: 'inside' }),
  ])
  const board = canvasOf([
    buildFileNode({ id: 'fa', file: 'doc-a', x: 0, y: 0, width: 260, height: 180 }),
    buildFileNode({ id: 'fb', file: 'doc-b', x: 300, y: 0, width: 160, height: 80 }),
    buildFileNode({ id: 'fg', file: 'doc-gone', x: 0, y: 220, width: 160, height: 80 }),
    buildFileNode({ id: 'fc', file: 'doc-c', x: 300, y: 220, width: 160, height: 80 }),
  ])
  const wire = referenceWire(
    new Map([
      ['doc-a', { name: 'Stored A', canvas: inner }],
      ['doc-b', { name: 'Stored B', body: '# B\n\nprose' }],
      ['doc-gone', null],
    ]),
    { extras: new Map([['doc-b', { label: 'Extra B' }]]) },
  )
  const fileRefOptions = [
    { file: 'doc-a', label: 'Alpha' },
    { file: 'doc-b', label: 'Beta' },
    { file: 'doc-elsewhere', label: 'Not on this board' },
  ]
  const missingFileRef = (file: string) => file === 'doc-gone'

  it('labels a file node inside a canvas the board loads, as the function overlay did', async () => {
    const nested = canvasOf([
      buildFileNode({ id: 'inner-f', file: 'doc-deep', x: 0, y: 0, width: 160, height: 80 }),
    ])
    const outer = canvasOf([
      buildFileNode({ id: 'fo', file: 'doc-outer', x: 0, y: 0, width: 400, height: 300 }),
    ])
    const loaded = referenceWire(new Map([['doc-outer', { canvas: nested }]]))
    const options = [{ file: 'doc-deep', label: 'Deep label' }]
    const { result } = renderHook(() =>
      useFileSeamScene({
        canvas: outer,
        zoom: 1,
        references: loaded,
        fileRefOptions: options,
        missingFileRef: undefined,
        resolvedMeasure: fixedMeasure,
        theme: 'light',
      }),
    )
    await waitFor(() => expect(result.current.wire.expandedFileIds).toEqual(['fo']))
    const after = renderCanvasToSvg(outer, {
      measure: fixedMeasure,
      ...result.current.fileSeamOptions,
    })
    expect(after.svg).toContain('Deep label')
  })

  /** The one request a layout with `options` hands the core, through the editor's own base. */
  function requestFor(canvas: SpatialCanvas, options: Partial<SpatialLayoutOptions>) {
    const asked: CanvasLayoutRequest[] = []
    const core = fakeLayoutCore({
      layout: {
        layoutSpatialCanvas: (request) => {
          asked.push(request)
          return { scene: { nodes: [] }, anchors: new Map(), degradations: [] }
        },
      },
    })
    const base = editorLayoutBase({ measure: constantRatioMeasureText })
    layoutSpatialCanvasWithAnchors(canvas, { ...base, ...options, core })
    expect(asked).toHaveLength(1)
    return asked[0]
  }

  it('keeps the chrome of file nodes past the loading budget, which bounds content only', () => {
    // 256 is the walk's loading budget (REFERENCE_BUDGET): two more distinct
    // references than that, the last two labelled and dangling. The budget
    // bounds what is LOADED; a label and a dangling mark are chrome the host
    // already holds, so they ride the wire for every node on the board.
    const many = canvasOf(
      Array.from({ length: 258 }, (_, i) =>
        buildFileNode({
          id: `n${i}`,
          file: `doc-${i}`,
          x: (i % 20) * 60,
          y: Math.floor(i / 20) * 40,
          width: 50,
          height: 30,
        }),
      ),
    )
    const options = [{ file: 'doc-256', label: 'Past the budget' }]
    const { result } = renderHook(() =>
      useFileSeamScene({
        canvas: many,
        zoom: 1,
        references: referenceWire(new Map()),
        fileRefOptions: options,
        missingFileRef: (file) => file === 'doc-257',
        resolvedMeasure: constantRatioMeasureText,
        theme: 'light',
      }),
    )
    const extras = Object.fromEntries(result.current.wire.references?.extras ?? [])
    expect(extras['doc-256']).toEqual({ label: 'Past the budget' })
    expect(extras['doc-257']).toEqual({ missing: true })
    // And the request the core is handed carries the same chrome.
    const request = requestFor(many, result.current.fileSeamOptions)
    const asked = Object.fromEntries(request?.references?.extras ?? [])
    expect(asked['doc-256']).toEqual({ label: 'Past the budget' })
    expect(asked['doc-257']).toEqual({ missing: true })
  })

  it('hands the core the chrome a host holds without a wire, and draws its labels', () => {
    const { result } = renderHook(() =>
      useFileSeamScene({
        canvas: board,
        zoom: 1,
        references: undefined,
        fileRefOptions,
        missingFileRef,
        resolvedMeasure: fixedMeasure,
        theme: 'light',
      }),
    )
    const { fileSeamOptions, wire: handed } = result.current
    // Nothing to expand into: a host with no wire resolves no content.
    expect(fileSeamOptions.expandFileNode).toBeUndefined()
    // The chrome rides a wire of its own: the board's labels and its dangling
    // reference, never a label for a file this board does not show.
    const chrome = {
      'doc-a': { label: 'Alpha' },
      'doc-b': { label: 'Beta' },
      'doc-gone': { missing: true },
    }
    expect(Object.fromEntries(handed.references?.extras ?? [])).toEqual(chrome)
    expect(handed.references?.entries).toEqual([])
    expect(
      Object.fromEntries(requestFor(board, fileSeamOptions)?.references?.extras ?? []),
    ).toEqual(chrome)
    const after = renderCanvasToSvg(board, { measure: fixedMeasure, ...fileSeamOptions })
    expect(after.svg).toContain('Alpha')
    expect(after.svg).toContain('Beta')
  })

  it("hands the core the editor's own layout options as a request, extras and fragment table included", async () => {
    const { result } = renderHook(() =>
      useFileSeamScene({
        canvas: board,
        zoom: 1,
        references: wire,
        fileRefOptions,
        missingFileRef,
        resolvedMeasure: constantRatioMeasureText,
        theme: 'light',
      }),
    )
    await waitFor(() => expect(result.current.wire.expandedFileIds).toEqual(['fa']))
    const ask = (options: Partial<SpatialLayoutOptions>) => {
      const asked: CanvasLayoutRequest[] = []
      const core = fakeLayoutCore({
        layout: {
          layoutSpatialCanvas: (request) => {
            asked.push(request)
            return { scene: { nodes: [] }, anchors: new Map(), degradations: [] }
          },
        },
      })
      const base = editorLayoutBase({ measure: constantRatioMeasureText })
      // An option no request carries would throw `CoreUnaskable` here.
      layoutSpatialCanvasWithAnchors(board, { ...base, ...options, core })
      return { asked }
    }
    // Every option the editor lays out with, its typeset math and diagrams
    // included: they ride as a table, which the core answers from.
    const { asked } = ask(result.current.fileSeamOptions)
    expect(asked).toHaveLength(1)
    expect(asked[0]?.expand).toEqual(['fa'])
    expect(Object.fromEntries(asked[0]?.references?.extras ?? [])).toEqual({
      'doc-a': { label: 'Alpha' },
      'doc-b': { label: 'Beta' },
      'doc-gone': { missing: true },
    })
    expect(asked[0]?.fragments).toEqual([])
  })
})
