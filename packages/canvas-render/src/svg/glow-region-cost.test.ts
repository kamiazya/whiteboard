// The cost of glow in a rasteriser. resvg allocates and blurs a layer the size
// of a filter's REGION for every element that references it, so a board's PNG
// export costs, per glowing element, the area of the region that element's
// filter declares. This counts that sum over a many-element glowing board and
// holds it to the elements' own padded extents: a region that grows with the
// SCENE makes the export quadratic in the board (each element times every
// pixel), and that is what this test exists to catch.

import type { ResolvedEdgeNode, Scene, ShapeSceneNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { glowReachPx } from '../layout/ink/glow.js'
import { renderSceneToSvg } from './backend.js'

const GLOW = { radiusPx: 6 } as const
const COLUMNS = 15
const ROWS = 15
const PITCH = 140
const BOX = { w: 100, h: 60 } as const
const STROKE = 1.8

function board(): Scene {
  const nodes: Array<ShapeSceneNode | ResolvedEdgeNode> = []
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLUMNS; col++) {
      const x = col * PITCH
      const y = row * PITCH
      nodes.push({
        kind: 'shape',
        id: `n-${row}-${col}`,
        bbox: { x, y, ...BOX },
        appearance: { fill: '#083344', stroke: '#67e8f9', strokeWidth: STROKE, glow: GLOW },
      })
      if (col + 1 < COLUMNS) {
        nodes.push({
          kind: 'edge',
          id: `e-${row}-${col}`,
          path: [
            { x: x + BOX.w, y: y + BOX.h / 2 },
            { x: x + PITCH, y: y + BOX.h / 2 },
          ],
          fromSide: 'right',
          toSide: 'left',
          fromEnd: 'none',
          toEnd: 'arrow',
          appearance: { stroke: '#f472b6', strokeWidth: STROKE, glow: GLOW },
        })
      }
    }
  }
  return { nodes }
}

/** Each glow filter's declared region area, by id. */
function regionAreas(svg: string): Map<string, number> {
  const areas = new Map<string, number>()
  const pattern =
    /<filter id="(wb-glow-[^"]+)" filterUnits="userSpaceOnUse" x="[^"]+" y="[^"]+" width="([^"]+)" height="([^"]+)"/g
  for (const match of svg.matchAll(pattern)) {
    areas.set(match[1]!, Number(match[2]) * Number(match[3]))
  }
  return areas
}

describe('glow filter regions', () => {
  it('a glowing board rasterises regions bounded by each element, not by the scene', () => {
    const scene = board()
    const svg = renderSceneToSvg(scene)
    const areas = regionAreas(svg)
    const references = [...svg.matchAll(/filter="url\(#(wb-glow-[^)]+)\)"/g)].map((m) => m[1]!)
    // The subject is present: every element glows and every reference resolves.
    expect(references.length).toBe(scene.nodes.length)
    expect(references.every((id) => areas.has(id))).toBe(true)

    const rasterised = references.reduce((sum, id) => sum + areas.get(id)!, 0)
    // Generous per-element budget: the box (no edge segment is longer)
    // padded on every side by the halo's reach plus the stroke and a margin.
    const pad = glowReachPx(GLOW.radiusPx) + STROKE + 4
    const perElement = (BOX.w + 2 * pad) * (BOX.h + 2 * pad)
    expect(rasterised).toBeLessThanOrEqual(references.length * perElement)
  })
})
