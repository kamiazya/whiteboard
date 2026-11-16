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
  type LayoutCore,
  layoutSpatialCanvasWithAnchors,
  type MeasureText,
  type ResolvedReference,
  referenceSeamsFromWire,
  referenceWire,
  referenceWireFor,
  type SpatialLayoutOptions,
} from '@kamiazya/whiteboard-canvas-render'
import { createFixedMeasure } from '@kamiazya/whiteboard-canvas-render/test-utils'
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

/**
 * What the editor composed before the chrome rode the wire: the host's
 * `resolveReference` with the label table and the dangling set layered over
 * it as a function. Restated here as the BEFORE half, since that function
 * could never reach a worker's request gate or the core.
 */
function overlayAsFunction(
  content: (ref: string) => ResolvedReference | undefined,
  labels: ReadonlyMap<string, string>,
  missing: ReadonlySet<string>,
): (ref: string) => ResolvedReference | undefined {
  return (ref) => {
    const resolved = content(ref)
    const label = labels.get(ref)
    if (resolved === undefined && label === undefined && !missing.has(ref)) return undefined
    return {
      ...resolved,
      ...(label !== undefined ? { label } : {}),
      ...(missing.has(ref) ? { missing: true } : {}),
    }
  }
}

/**
 * The scene the editor drew with that function: canvas-render's layout under
 * the editor's own base, since the editor's options no longer take one.
 */
function functionOverlayScene(canvas: SpatialCanvas, options: Partial<SpatialLayoutOptions>) {
  return layoutSpatialCanvasWithAnchors(canvas, {
    ...editorLayoutBase({ measure: fixedMeasure }),
    ...options,
  }).scene
}

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

  it('draws labelled, resolved and dangling file nodes as the function overlay did, from a wire alone', async () => {
    const { result } = renderHook(() =>
      useFileSeamScene({
        canvas: board,
        zoom: 1,
        references: wire,
        fileRefOptions,
        missingFileRef,
        resolvedMeasure: fixedMeasure,
        theme: 'light',
      }),
    )
    await waitFor(() => expect(result.current.wire.expandedFileIds).toEqual(['fa']))
    const { fileSeamOptions } = result.current
    // No function seam: the bundle is rebuilt from a wire the request gate can hand on.
    expect(fileSeamOptions).not.toHaveProperty('resolveReference')

    const seams = referenceSeamsFromWire(referenceWireFor(wire, { canvases: [board] }))
    const labels = new Map(fileRefOptions.map((option) => [option.file, option.label]))
    const before = functionOverlayScene(board, {
      references: seams,
      resolveReference: overlayAsFunction(seams.resolveReference, labels, new Set(['doc-gone'])),
      expandFileNode: fileSeamOptions.expandFileNode,
    })
    const after = renderCanvasToSvg(board, { measure: fixedMeasure, ...fileSeamOptions })
    expect(after.scene).toEqual(before)

    // The chrome is what this board is about: without it the board draws otherwise.
    const bare = renderCanvasToSvg(board, {
      measure: fixedMeasure,
      references: seams,
      expandFileNode: fileSeamOptions.expandFileNode,
    })
    expect(bare.scene).not.toEqual(before)
    expect(after.svg).toContain('Beta')
    expect(after.svg).not.toContain('Extra B')
  })

  it('draws the chrome a host hands without a wire, as the function overlay did', () => {
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
    const { fileSeamOptions } = result.current
    expect(fileSeamOptions.expandFileNode).toBeUndefined()
    const labels = new Map(fileRefOptions.map((option) => [option.file, option.label]))
    const before = functionOverlayScene(board, {
      resolveReference: overlayAsFunction(() => undefined, labels, new Set(['doc-gone'])),
    })
    const after = renderCanvasToSvg(board, { measure: fixedMeasure, ...fileSeamOptions })
    expect(after.scene).toEqual(before)
    expect(after.svg).toContain('Alpha')
  })

  it('keeps the chrome of file nodes past the loading budget, which bounds content only', () => {
    // 256 is the walk's loading budget (REFERENCE_BUDGET): two more distinct
    // references than that, the last two labelled and dangling.
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
        resolvedMeasure: fixedMeasure,
        theme: 'light',
      }),
    )
    const extras = Object.fromEntries(result.current.wire.references?.extras ?? [])
    expect(extras['doc-256']).toEqual({ label: 'Past the budget' })
    expect(extras['doc-257']).toEqual({ missing: true })
    const seams = referenceSeamsFromWire(referenceWire(new Map()))
    const before = functionOverlayScene(many, {
      references: seams,
      expandFileNode: result.current.fileSeamOptions.expandFileNode,
      resolveReference: overlayAsFunction(
        seams.resolveReference,
        new Map([['doc-256', 'Past the budget']]),
        new Set(['doc-257']),
      ),
    })
    const after = renderCanvasToSvg(many, {
      measure: fixedMeasure,
      ...result.current.fileSeamOptions,
    })
    expect(after.scene).toEqual(before)
  })

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
      const skipped: string[] = []
      const core: LayoutCore = {
        routing: { routeLayout: () => ({ declined: 'unused' }) as never },
        layout: {
          layoutSpatialCanvas: (request) => {
            asked.push(request)
            return { declined: 'recording' } as never
          },
        },
        impl: { routeLayout: 'ts', layoutSpatialCanvas: 'differential' },
        onMismatch: (mismatch) => {
          if (mismatch.kind === 'skipped') skipped.push(mismatch.reason)
        },
      }
      const base = editorLayoutBase({ measure: constantRatioMeasureText })
      layoutSpatialCanvasWithAnchors(board, { ...base, ...options, core })
      return { asked, skipped }
    }
    // Every option the editor lays out with, its typeset math and diagrams
    // included: they ride as a table, which the core answers from.
    const { asked, skipped } = ask(result.current.fileSeamOptions)
    expect(skipped).toEqual([])
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
