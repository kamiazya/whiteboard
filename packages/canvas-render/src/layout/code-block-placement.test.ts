/**
 * A fenced block's TEXT has to travel with the panel behind it.
 *
 * `layoutMdastBlocks` lays a body out at its own origin and the composer
 * moves it to the node's position, so every container in the scene graph
 * has to hand its children to that move. `codeBlock` did not: the panel
 * arrived at the node and its runs stayed where the body was typeset, which
 * on a canvas is wherever the origin happens to be — so the block rendered
 * as an empty grey slab, and the code was painted somewhere nobody was
 * looking. Reported against an embedded document and a plain text node
 * alike, which is the tell: both go through the same translation.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { CodeBlockNode, SceneNode, TextRunNode } from '@kamiazya/whiteboard-scene'
import { expect, it } from 'vitest'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import { layoutSpatialCanvas } from './spatial-canvas.js'

const BODY = ['# Title', '', '```', 'const a = 1', '```'].join('\n')

function canvasAt(x: number, y: number): SpatialCanvas {
  return {
    nodes: [{ id: 'n1', type: 'text', text: BODY, x, y, width: 400, height: 320 }],
    edges: [],
  } as unknown as SpatialCanvas
}

function findCodeBlock(nodes: readonly SceneNode[]): CodeBlockNode {
  for (const node of nodes) {
    if (node.kind === 'codeBlock') return node
    const children = (node as { children?: readonly SceneNode[] }).children
    if (children !== undefined) return findCodeBlock(children)
  }
  throw new Error('no codeBlock in the scene')
}

function runsOf(block: CodeBlockNode): readonly TextRunNode[] {
  const runs = block.runs
  if (runs === undefined || runs.length === 0) throw new Error('the code block has no runs')
  return runs
}

it('keeps a code run inside its own panel wherever the node sits', () => {
  const scene = layoutSpatialCanvas(canvasAt(2000, 1500), {
    measure: createFakeMeasure(),
    appearance: createSpatialTheme({ mode: 'dark' }),
  })
  const block = findCodeBlock(scene.nodes)
  for (const run of runsOf(block)) {
    expect(run.bbox.x).toBeGreaterThanOrEqual(block.bbox.x)
    expect(run.bbox.y).toBeGreaterThanOrEqual(block.bbox.y)
    expect(run.bbox.y + run.bbox.h).toBeLessThanOrEqual(block.bbox.y + block.bbox.h)
  }
})

it('moves a code run by exactly what it moves the panel by', () => {
  const options = {
    measure: createFakeMeasure(),
    appearance: createSpatialTheme({ mode: 'dark' }),
  }
  const here = findCodeBlock(layoutSpatialCanvas(canvasAt(0, 0), options).nodes)
  const there = findCodeBlock(layoutSpatialCanvas(canvasAt(2000, 1500), options).nodes)
  const panelShift = { x: there.bbox.x - here.bbox.x, y: there.bbox.y - here.bbox.y }
  expect(panelShift).toEqual({ x: 2000, y: 1500 })

  const from = runsOf(here)
  const to = runsOf(there)
  expect(to.length).toBe(from.length)
  for (const [index, run] of to.entries()) {
    const origin = from[index] as TextRunNode
    expect({ x: run.bbox.x - origin.bbox.x, y: run.bbox.y - origin.bbox.y }).toEqual(panelShift)
  }
})
