// Glow is an SVG filter (ADR-0030 decision 8): a Gaussian blur of the
// element merged under itself, so the halo is the element's own colour. The
// filter REGION is declared in user space over the element's own extent,
// padded by half its stroke and the halo's reach — a region relative to the
// element's bounding box drops an axis-aligned straight edge entirely,
// because its box has zero area (measured on resvg 2.6.2; it is the
// specification's behaviour, so a browser does the same), and a region over
// the whole scene makes every glowing element rasterise the whole board.

import type {
  ResolvedEdgeNode,
  Scene,
  ShapeSceneNode,
  TextRunNode,
} from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { EDGE_JUMP_RADIUS_PX } from '../layout/edges/edge-jumps.js'
import { glowReachPx } from '../layout/ink/glow.js'
import { sceneBounds } from '../scene-bounds.js'
import { isWellFormedXmlFragment } from '../test-utils/xml-well-formed.js'
import { renderSceneToSvg } from './backend.js'

const GLOW = { radiusPx: 6 } as const

const rect: ShapeSceneNode = {
  kind: 'shape',
  id: 'n',
  bbox: { x: 20, y: 20, w: 100, h: 60 },
  appearance: { fill: '#083344', stroke: '#67e8f9', strokeWidth: 1.8, glow: GLOW },
}

const horizontal: ResolvedEdgeNode = {
  kind: 'edge',
  id: 'e',
  path: [
    { x: 0, y: 120 },
    { x: 200, y: 120 },
  ],
  fromSide: 'right',
  toSide: 'left',
  fromEnd: 'none',
  toEnd: 'arrow',
  appearance: { stroke: '#f472b6', strokeWidth: 1.8, glow: { radiusPx: 6 } },
}

const label: TextRunNode = {
  kind: 'textRun',
  bbox: { x: 30, y: 30, w: 40, h: 16 },
  text: 'neon',
  appearance: { fill: '#e0f2fe', fontSize: 14, glow: { radiusPx: 4 } },
}

describe('glow in the SVG backend', () => {
  it('a glowing rect references one filter declared in user space', () => {
    const svg = renderSceneToSvg({ nodes: [rect] })
    expect(isWellFormedXmlFragment(svg)).toBe(true)
    expect(svg).toMatch(/<filter id="wb-glow-[^"]*" filterUnits="userSpaceOnUse" x="/)
    expect(svg).toContain('<feGaussianBlur stdDeviation="3"')
    expect(svg).toContain('<feMergeNode in="SourceGraphic"/>')
    expect(svg).toMatch(/<rect [^>]*filter="url\(#wb-glow-[^"]*\)"/)
  })

  it('an axis-aligned edge, a text run and a shape all carry the filter attribute', () => {
    const svg = renderSceneToSvg({ nodes: [rect, horizontal, label] })
    expect(svg).toMatch(/<polyline [^>]*filter="url\(#wb-glow-/)
    expect(svg).toMatch(/<text [^>]*filter="url\(#wb-glow-/)
    // One region per element: the rect and the edge share a radius, not a box.
    expect(svg.match(/<filter /g)?.length).toBe(3)
  })

  it("an axis-aligned edge's region spans its own line padded by the halo, not the scene", () => {
    const svg = renderSceneToSvg({ nodes: [rect, horizontal] })
    const regions = [
      ...svg.matchAll(/<filter [^>]*x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/g),
    ].map(([, x, y, w, h]) => ({ x: Number(x), y: Number(y), w: Number(w), h: Number(h) }))
    const pad = Math.ceil(glowReachPx(6) + 1.8 / 2)
    // The line runs 0..200 at y=120; only its arrowhead's wings widen it.
    const line = regions.find((r) => r.w >= 200)
    expect(line).toBeDefined()
    expect(line!.x).toBe(0 - pad)
    expect(line!.y).toBeLessThanOrEqual(120 - pad)
    expect(line!.y + line!.h).toBeGreaterThanOrEqual(120 + pad)
    expect(line!.h).toBeLessThan(4 * pad)
    const box = regions.find((r) => r !== line)
    expect(box).toEqual({ x: 20 - pad, y: 20 - pad, w: 100 + 2 * pad, h: 60 + 2 * pad })
  })

  it("a hop's half-circle widens a straight edge's region by the jump radius", () => {
    const plain: ResolvedEdgeNode = { ...horizontal, toEnd: 'none' }
    const hopped: ResolvedEdgeNode = { ...plain, jumps: [{ segment: 0, x: 100, y: 120 }] }
    const height = (edge: ResolvedEdgeNode) =>
      Number(renderSceneToSvg({ nodes: [edge] }).match(/<filter [^>]* height="([^"]+)"/)![1])
    expect(height(hopped) - height(plain)).toBe(2 * EDGE_JUMP_RADIUS_PX)
  })

  it('renders byte-identically twice and unchanged without glow', () => {
    const scene: Scene = { nodes: [rect, horizontal, label] }
    expect(renderSceneToSvg(scene)).toBe(renderSceneToSvg(scene))
    const { glow: _g, ...plain } = rect.appearance!
    const svg = renderSceneToSvg({ nodes: [{ ...rect, appearance: plain }] })
    expect(svg).not.toContain('filter')
    expect(svg).not.toContain('<defs>')
  })
})

describe('sceneBounds with glow', () => {
  it('widens a glowing node by the declared reach for its radius', () => {
    const { glow: _g, ...plain } = rect.appearance!
    const crisp = sceneBounds({ nodes: [{ ...rect, appearance: plain }] })
    const glowing = sceneBounds({ nodes: [rect] })
    const reach = glowReachPx(GLOW.radiusPx)
    expect(reach).toBeGreaterThan(0)
    expect(glowing).toEqual({
      x: crisp.x - reach,
      y: crisp.y - reach,
      w: crisp.w + 2 * reach,
      h: crisp.h + 2 * reach,
    })
  })
})
