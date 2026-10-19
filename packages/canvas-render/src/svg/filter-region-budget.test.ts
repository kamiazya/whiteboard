// The total raster work an SVG's filters ask for. A rasteriser blurs a layer
// the size of a filter's REGION for every element that references it, so the
// cost of an export is the SUM of those regions — and nothing per element
// bounds that sum: a corner-to-corner edge's own extent is the whole scene,
// and comment bubbles stack. This counts the sum straight off the SVG (its
// own parser, not the backend's) and holds it to the backend's budget.

import type { ResolvedEdgeNode, Scene, ShapeSceneNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { renderSceneToSvg } from './backend.js'

/**
 * The budget in glow-equivalent device pixels. Measured with resvg: a glow
 * region costs about 270ms per megapixel, a drop shadow about 550ms, so a
 * drop-shadow pixel counts twice and the worst admitted render is about 2s.
 */
const BUDGET = 8_000_000
const DROP_SHADOW_WEIGHT = 2

type Box = readonly [x: number, y: number, w: number, h: number]

function clippedArea([x, y, w, h]: Box, [cx, cy, cw, ch]: Box): number {
  const width = Math.max(0, Math.min(x + w, cx + cw) - Math.max(x, cx))
  const height = Math.max(0, Math.min(y + h, cy + ch) - Math.max(y, cy))
  return width * height
}

/** Weighted filter-region area at `scale`, clipped to the viewBox, read from the SVG text. */
function filterWork(svg: string, scale = 1): { references: number; work: number } {
  const viewBox = /viewBox="([^"]+)"/.exec(svg)![1]!.split(' ').map(Number) as unknown as Box
  const userSpace = new Map<string, Box>()
  for (const m of svg.matchAll(
    /<filter id="([^"]+)" filterUnits="userSpaceOnUse" x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/g,
  )) {
    userSpace.set(m[1]!, m.slice(2, 6).map(Number) as unknown as Box)
  }
  let references = 0
  let work = 0
  for (const m of svg.matchAll(/<\w+ ([^>]*?)filter="url\(#([^)]+)\)"/g)) {
    references++
    const id = m[2]!
    let region = userSpace.get(id)
    if (region === undefined) {
      const attr = (name: string) => Number(new RegExp(` ${name}="([^"]+)"`).exec(` ${m[1]}`)?.[1])
      const [x, y, w, h] = [attr('x'), attr('y'), attr('width'), attr('height')]
      region = [x - 0.3 * w, y - 0.3 * h, 1.6 * w, 1.6 * h]
    }
    const weight = id === 'wb-drop-shadow' ? DROP_SHADOW_WEIGHT : 1
    work += weight * clippedArea(region, viewBox) * scale * scale
  }
  return { references, work }
}

const GLOW = { radiusPx: 6 } as const
const SIDE = 2000

function cornerEdgeBoard(count: number): Scene {
  const corners = (i: number): ResolvedEdgeNode => ({
    kind: 'edge',
    id: `e${i}`,
    // Each a pixel apart, so every edge declares a filter of its own.
    path: [
      { x: i % 50, y: 0 },
      { x: SIDE, y: SIDE },
    ],
    fromSide: 'right',
    toSide: 'left',
    fromEnd: 'none',
    toEnd: 'arrow',
    appearance: { stroke: '#f472b6', strokeWidth: 2, glow: GLOW },
  })
  const anchor = (id: string, x: number, y: number): ShapeSceneNode => ({
    kind: 'shape',
    id,
    bbox: { x, y, w: 100, h: 60 },
    appearance: { fill: '#083344', stroke: '#67e8f9', strokeWidth: 2, glow: GLOW },
  })
  return {
    nodes: [
      anchor('a', 0, 0),
      anchor('b', SIDE - 100, SIDE - 60),
      ...Array.from({ length: count }, (_, i) => corners(i)),
    ],
  }
}

/** Comment chrome as the theme paints it: a pin and a tall bubble, both drop-shadowed. */
function stackedBubbleBoard(count: number): Scene {
  const shadowed = (id: string, bbox: ShapeSceneNode['bbox'], rx: number): ShapeSceneNode => ({
    kind: 'shape',
    id,
    bbox,
    radius: rx,
    appearance: { fill: '#ffffff', stroke: '#d97706', dropShadow: true },
  })
  return {
    nodes: Array.from({ length: count }, (_, i) => [
      shadowed(`pin${i}`, { x: 150, y: -10, w: 20, h: 20 }, 10),
      shadowed(`bubble${i}`, { x: 174, y: 14, w: 216, h: 3760 }, 8),
    ]).flat(),
  }
}

describe('filter region budget', () => {
  it('bounds the summed glow regions of corner-to-corner edges', () => {
    const svg = renderSceneToSvg(cornerEdgeBoard(200), { padding: 10 })
    const { references, work } = filterWork(svg)
    // The subject is present: the board still glows.
    expect(references).toBeGreaterThan(0)
    expect(work).toBeLessThanOrEqual(BUDGET)
  })

  it('bounds the summed drop-shadow regions of stacked comment bubbles', () => {
    const svg = renderSceneToSvg(stackedBubbleBoard(500), { padding: 10 })
    const { references, work } = filterWork(svg)
    expect(references).toBeGreaterThan(0)
    expect(work).toBeLessThanOrEqual(BUDGET)
  })

  it('drops the largest regions first, and their definitions with them', () => {
    const svg = renderSceneToSvg(cornerEdgeBoard(200), { padding: 10 })
    const referenced = new Set([...svg.matchAll(/filter="url\(#([^)]+)\)"/g)].map((m) => m[1]))
    const declared = [...svg.matchAll(/<filter id="([^"]+)"/g)].map((m) => m[1])
    // The two small anchors keep their glow; the scene-sized edges lose theirs.
    expect(svg.match(/<rect [^>]*filter="url\(#wb-glow-/g)).toHaveLength(2)
    expect(declared.every((id) => referenced.has(id))).toBe(true)
  })

  it('budgets in device pixels at the raster scale', () => {
    // One corner edge sums about 4M: inside the budget at 1x, four times it at 2x.
    const scene = cornerEdgeBoard(1)
    const at1x = filterWork(renderSceneToSvg(scene, { padding: 10 }))
    const at2x = filterWork(renderSceneToSvg(scene, { padding: 10, rasterScale: 2 }), 2)
    expect(at1x.references).toBe(3)
    expect(at2x.references).toBeLessThan(3)
    expect(at2x.work).toBeLessThanOrEqual(BUDGET)
  })

  it('treats an unset raster scale as 1x', () => {
    const scene = cornerEdgeBoard(1)
    expect(renderSceneToSvg(scene, { padding: 10, rasterScale: 1 })).toBe(
      renderSceneToSvg(scene, { padding: 10 }),
    )
    expect(filterWork(renderSceneToSvg(scene, { padding: 10 })).references).toBe(3)
  })

  it('charges a region only inside the document box', () => {
    // A glowing box a hundred times the viewport: unclipped its region is 25M,
    // inside the 500px viewBox it is a quarter of a megapixel.
    const scene: Scene = {
      nodes: [
        {
          kind: 'shape',
          id: 'vast',
          bbox: { x: 0, y: 0, w: 5000, h: 5000 },
          appearance: { stroke: '#67e8f9', strokeWidth: 2, glow: GLOW },
        },
      ],
    }
    const svg = renderSceneToSvg(scene, { viewBox: { x: 0, y: 0, w: 500, h: 500 } })
    expect(filterWork(svg).references).toBe(1)
  })
})
