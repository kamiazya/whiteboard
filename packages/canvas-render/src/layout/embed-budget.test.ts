// One render lays out a bounded number of NESTED documents, whatever the
// fan-out. The depth cap alone bounds how deep an embed goes, not how wide:
// a canvas of k file nodes each embedding a canvas of k file nodes costs
// k + k² + k³ layouts under a depth cap of 3, which a hostile (or merely
// enthusiastic) workspace turns into a render that never finishes. The
// budget is shared across the markdown/canvas boundary, so neither kind of
// embed can be used to spend around it.

import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { SceneNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { layoutMdastBlocks } from './markdown-body.js'
import { NESTED_LAYOUT_BUDGET } from './nodes/embed-budget.js'
import type { FittedBlocks } from './nodes/mdast-blocks.js'
import { layoutSpatialCanvas, type SpatialLayoutOptions } from './spatial-canvas.js'

const APPEARANCE = {
  resolveNode: () => ({}),
  resolveEdge: () => ({}),
  resolveLabel: () => ({}),
}

/** Wide enough that FAN_OUT + FAN_OUT² + FAN_OUT³ is well past the budget. */
const FAN_OUT = 6

function count(nodes: readonly SceneNode[], kind: string, reason?: string): number {
  let total = 0
  const visit = (node: SceneNode) => {
    const entry = node as {
      kind: string
      reason?: string
      runs?: readonly SceneNode[]
      children?: readonly SceneNode[]
    }
    if (entry.kind === kind && (reason === undefined || entry.reason === reason)) total += 1
    for (const run of entry.runs ?? []) visit(run)
    for (const child of entry.children ?? []) visit(child)
  }
  for (const node of nodes) visit(node)
  return total
}

/** A canvas of FAN_OUT file nodes, each naming a distinct child of `id`. */
function fanOutCanvas(id: string): SpatialCanvas {
  const nodes: SpatialNode[] = Array.from({ length: FAN_OUT }, (_, j) =>
    fileNode({ id: `n${j}`, x: j * 300, y: 0, width: 260, height: 200, file: `${id}/${j}` }),
  )
  return { nodes, edges: [] }
}

/** A body of FAN_OUT block embeds, each naming a distinct child of `id`. */
function fanOutBody(id: string): MdastRoot {
  return {
    type: 'root',
    children: Array.from({ length: FAN_OUT }, (_, j) => ({
      type: 'paragraph' as const,
      children: [{ type: 'embed' as const, documentId: `${id}/${j}` }],
    })),
  }
}

describe('nested layout budget', () => {
  it('bounds file-node canvas embeds under a wide fan-out', () => {
    let resolved = 0
    const options: SpatialLayoutOptions = {
      measure: createFakeMeasure(),
      parseBody: () => ({ type: 'root', children: [] }),
      appearance: APPEARANCE,
      resolveReference: (ref) => {
        resolved += 1
        return { canvas: fanOutCanvas(ref) }
      },
      expandFileNode: () => true,
    }
    const scene = layoutSpatialCanvas(fanOutCanvas('root'), options)

    const embeds = count(scene.nodes, 'embedResolved')
    // Present: the budget degrades the excess, not the whole render.
    expect(embeds).toBeGreaterThan(FAN_OUT)
    expect(embeds).toBeLessThanOrEqual(NESTED_LAYOUT_BUDGET)
    // Each nested layout resolves its own FAN_OUT file nodes once.
    expect(resolved).toBeLessThanOrEqual(FAN_OUT * (NESTED_LAYOUT_BUDGET + 1))
    // Every top-level node still draws — a degraded one as its card.
    expect(scene.nodes.filter((n) => n.kind === 'shape').length).toBeGreaterThanOrEqual(FAN_OUT)
  })

  it('bounds markdown block embeds and marks the excess as over budget', () => {
    let resolved = 0
    const scene = layoutMdastBlocks(fanOutBody('root'), {
      measure: createFakeMeasure(),
      maxWidth: 600,
      fontFamily: 'sans-serif',
      resolveEmbed: (id) => {
        resolved += 1
        return { root: fanOutBody(id) }
      },
    })

    const embeds = count(scene.nodes, 'embedResolved')
    expect(embeds).toBeGreaterThan(FAN_OUT)
    expect(embeds).toBeLessThanOrEqual(NESTED_LAYOUT_BUDGET)
    expect(resolved).toBeLessThanOrEqual(FAN_OUT * (NESTED_LAYOUT_BUDGET + 1))
    expect(count(scene.nodes, 'embedPlaceholder', 'budget')).toBeGreaterThan(0)
  })

  it('shares one budget across the canvas/markdown boundary', () => {
    // canvas text node -> body ![[canvas]] -> FAN_OUT text nodes -> body ![[canvas]] …
    let resolved = 0
    const textCanvas = (id: string): SpatialCanvas => ({
      nodes: Array.from({ length: FAN_OUT }, (_, j) =>
        textNode({ id: `t${j}`, x: j * 300, y: 0, width: 260, height: 200, text: `${id}/${j}` }),
      ),
      edges: [],
    })
    const scene = layoutSpatialCanvas(textCanvas('root'), {
      measure: createFakeMeasure(),
      appearance: APPEARANCE,
      parseBody: (text) => ({
        type: 'root',
        children: [{ type: 'paragraph', children: [{ type: 'embed', documentId: text }] }],
      }),
      resolveEmbed: (id) => {
        resolved += 1
        return { canvas: textCanvas(id) }
      },
    })

    const embeds = count(scene.nodes, 'embedResolved')
    expect(embeds).toBeGreaterThan(FAN_OUT)
    expect(embeds).toBeLessThanOrEqual(NESTED_LAYOUT_BUDGET)
    // A canvas-targeted embed asks twice: once for the block, once for the
    // title run along its frame.
    expect(resolved).toBeLessThanOrEqual(2 * FAN_OUT * (NESTED_LAYOUT_BUDGET + 1))
  })

  it('a note shares its budget with the canvases it embeds', () => {
    // note of FAN_OUT ![[canvas]] -> FAN_OUT text nodes whose bodies embed the next
    // canvas. The bodies go through the default markdown parser, where only
    // a document id names itself, so every target is a fresh ULID.
    let minted = 0
    const mintId = () =>
      `01ARZ3NDEKTSV4RRFFQ69G${(minted++).toString(32).toUpperCase().padStart(4, '0')}`
    const textCanvas = (): SpatialCanvas => ({
      nodes: Array.from({ length: FAN_OUT }, (_, j) =>
        textNode({
          id: `t${j}`,
          x: j * 300,
          y: 0,
          width: 260,
          height: 200,
          text: `![[${mintId()}]]`,
        }),
      ),
      edges: [],
    })
    const scene = layoutMdastBlocks(
      {
        type: 'root',
        children: Array.from({ length: FAN_OUT }, () => ({
          type: 'paragraph' as const,
          children: [{ type: 'embed' as const, documentId: mintId() }],
        })),
      },
      {
        measure: createFakeMeasure(),
        maxWidth: 600,
        fontFamily: 'sans-serif',
        resolveEmbed: () => ({ canvas: textCanvas() }),
      },
    )
    const embeds = count(scene.nodes, 'embedResolved')
    expect(embeds).toBeGreaterThan(FAN_OUT)
    expect(embeds).toBeLessThanOrEqual(NESTED_LAYOUT_BUDGET)
  })

  it('does not cache a body laid out after the budget ran out', () => {
    const cache = new Map<string, FittedBlocks>()
    const options = (remaining: number): SpatialLayoutOptions => ({
      measure: createFakeMeasure(),
      appearance: APPEARANCE,
      parseBody: () => ({
        type: 'root',
        children: [{ type: 'paragraph', children: [{ type: 'embed', documentId: 'note' }] }],
      }),
      resolveEmbed: () => ({ root: { type: 'root', children: [] } }),
      contentCache: cache,
      nestedLayoutBudget: { remaining },
    })
    const canvas: SpatialCanvas = {
      nodes: [textNode({ id: 't', x: 0, y: 0, width: 260, height: 200, text: 'body' })],
      edges: [],
    }

    const spent = layoutSpatialCanvas(canvas, options(0))
    expect(count(spent.nodes, 'embedPlaceholder', 'budget')).toBe(1)
    expect(cache.size).toBe(0)

    const fresh = layoutSpatialCanvas(canvas, options(NESTED_LAYOUT_BUDGET))
    expect(count(fresh.nodes, 'embedResolved')).toBe(1)
    expect(cache.size).toBe(1)
  })
})
