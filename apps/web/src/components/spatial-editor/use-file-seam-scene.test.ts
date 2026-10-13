/**
 * Nearest-layer coverage for the LOD gate and the fragment seams the seam hook owns. The browser
 * suites (canvas-embed-lod, drag-ghost-embed) pin what an expanded file
 * node RENDERS as; this file pins the gate's own decisions — hysteresis
 * and the budget — at the layer they live, where each case is a zoom
 * number instead of a mounted editor.
 */

import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'
import { referenceSeams } from '@kamiazya/whiteboard-canvas-render'
import { createFixedMeasure } from '@kamiazya/whiteboard-canvas-render/test-utils'
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import {
  fileNode as buildFileNode,
  textNode as buildTextNode,
} from '@kamiazya/whiteboard-model/test-utils'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderCanvasToSvg } from '../../lib/spatial/scene-render.js'
import { useFileSeamScene } from './use-file-seam-scene.js'

const measure: MeasureText = () => ({ advanceWidth: 0, ascent: 0, descent: 0, lineGap: 0 })
const references = referenceSeams(new Map())
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
