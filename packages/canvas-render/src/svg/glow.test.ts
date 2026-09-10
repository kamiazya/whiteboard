// Glow is an SVG filter (ADR-0030 decision 8): a Gaussian blur of the
// element merged under itself, so the halo is the element's own colour. The
// filter REGION is declared in user space over the whole scene — a region
// relative to the element's bounding box drops an axis-aligned straight
// edge entirely, because its box has zero area (measured on resvg 2.6.2;
// it is the specification's behaviour, so a browser does the same).

import type {
  ResolvedEdgeNode,
  Scene,
  ShapeSceneNode,
  TextRunNode,
} from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
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
  it('a glowing rect references one filter declared in user space over the scene', () => {
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
    expect(svg.match(/<filter /g)?.length).toBe(2)
  })

  it('the filter region covers the scene bounds, which already include the glow reach', () => {
    const svg = renderSceneToSvg({ nodes: [horizontal] })
    const bounds = sceneBounds({ nodes: [horizontal] })
    const region = svg.match(
      /<filter [^>]*x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/,
    )
    expect(region).not.toBeNull()
    const [, x, y, w, h] = region!.map(Number)
    expect(x).toBeLessThanOrEqual(bounds.x)
    expect(y).toBeLessThanOrEqual(bounds.y)
    expect(x! + w!).toBeGreaterThanOrEqual(bounds.x + bounds.w)
    expect(y! + h!).toBeGreaterThanOrEqual(bounds.y + bounds.h)
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
