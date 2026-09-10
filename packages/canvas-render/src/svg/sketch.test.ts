import { describe, expect, it } from 'vitest'
import { SKETCH_INK_REACH_PX } from '../layout/ink/sketch.js'
import { sceneBounds } from '../scene-bounds.js'
import type { ResolvedEdgeNode, Scene, ShapeSceneNode } from '../scene-graph.js'
import { isWellFormedXmlFragment } from '../test-utils/xml-well-formed.js'
import { renderSceneToSvg } from './backend.js'

const inkedRect: ShapeSceneNode = {
  kind: 'shape',
  id: 'n',
  bbox: { x: 10, y: 10, w: 100, h: 60 },
  radius: 6,
  appearance: { fill: '#ffffff', stroke: '#333333', strokeWidth: 1.4 },
  ink: { style: 'sketch', seed: 42 },
}

const inkedEdge: ResolvedEdgeNode = {
  kind: 'edge',
  id: 'e',
  path: [
    { x: 0, y: 100 },
    { x: 200, y: 100 },
  ],
  fromSide: 'right',
  toSide: 'left',
  fromEnd: 'none',
  toEnd: 'arrow',
  appearance: { stroke: '#333333', strokeWidth: 1.4 },
  ink: { style: 'sketch', seed: 7 },
}

describe('sketch ink in the SVG backend', () => {
  it('an inked rect is a fill layer under round-capped stroke paths, and no <rect> stroke', () => {
    const svg = renderSceneToSvg({ nodes: [inkedRect] })
    expect(isWellFormedXmlFragment(svg)).toBe(true)
    expect(svg).toContain('stroke-linecap="round"')
    expect(svg.match(/<path /g)?.length).toBe(2)
    // The fill layer is the crisp silhouette with its stroke removed.
    expect(svg).toMatch(/<rect [^>]*fill="#ffffff"/)
    expect(svg).not.toMatch(/<rect [^>]*stroke=/)
  })

  it('the second pass is lighter than the first, so the doubled line reads as a pencil going over', () => {
    const svg = renderSceneToSvg({ nodes: [inkedRect] })
    const paths = svg.match(/<path [^>]*>/g) ?? []
    expect(paths).toHaveLength(2)
    expect(paths[0]).not.toContain('stroke-opacity')
    expect(paths[1]).toMatch(/stroke-opacity="0\.\d+"/)
    const edgeSvg = renderSceneToSvg({ nodes: [inkedEdge] })
    const edgePaths = edgeSvg.match(/<path [^>]*>/g) ?? []
    expect(edgePaths[1]).toMatch(/stroke-opacity="0\.\d+"/)
    // The arrowhead wings are single strokes and stay at full strength.
    expect(edgePaths[2]).not.toContain('stroke-opacity')
  })

  it('a hatched fill draws hatch lines in the stroke colour and no solid fill', () => {
    const svg = renderSceneToSvg({
      nodes: [{ ...inkedRect, ink: { style: 'sketch', seed: 42, fill: 'hatch' } }],
    })
    expect(svg).not.toMatch(/<rect /)
    expect(svg.match(/<path /g)!.length).toBeGreaterThan(4)
  })

  it('an inked edge is stroke paths with an inked arrowhead and no marker', () => {
    const svg = renderSceneToSvg({ nodes: [inkedEdge] })
    expect(isWellFormedXmlFragment(svg)).toBe(true)
    expect(svg).not.toContain('marker-end')
    expect(svg).not.toContain('<marker')
    expect(svg).not.toContain('<polyline')
    expect(svg.match(/<path /g)?.length).toBe(4)
  })

  it('renders byte-identically twice', () => {
    const scene: Scene = { nodes: [inkedRect, inkedEdge] }
    expect(renderSceneToSvg(scene)).toBe(renderSceneToSvg(scene))
  })

  it('the same node without ink renders exactly as before (additivity)', () => {
    const { ink: _ink, ...crisp } = inkedRect
    const svg = renderSceneToSvg({ nodes: [crisp] })
    expect(svg).toContain('<rect x="10" y="10" width="100" height="60" rx="6"')
    expect(svg).not.toContain('stroke-linecap')
  })
})

describe('sceneBounds with ink', () => {
  it('widens an inked shape and edge by the declared reach, and nothing else', () => {
    const crisp = sceneBounds({ nodes: [{ ...inkedRect, ink: undefined }] })
    const inked = sceneBounds({ nodes: [inkedRect] })
    expect(inked).toEqual({
      x: crisp.x - SKETCH_INK_REACH_PX,
      y: crisp.y - SKETCH_INK_REACH_PX,
      w: crisp.w + 2 * SKETCH_INK_REACH_PX,
      h: crisp.h + 2 * SKETCH_INK_REACH_PX,
    })
    const edgeCrisp = sceneBounds({ nodes: [{ ...inkedEdge, ink: undefined }] })
    const edgeInked = sceneBounds({ nodes: [inkedEdge] })
    expect(edgeInked.x).toBe(edgeCrisp.x - SKETCH_INK_REACH_PX)
    expect(edgeInked.w).toBe(edgeCrisp.w + 2 * SKETCH_INK_REACH_PX)
  })
})
