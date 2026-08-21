import { describe, expect, it } from 'vitest'
import type { ResolvedEdgeNode } from '../scene-graph.js'
import { renderSceneToSvg } from './backend.js'

const edge = (overrides: Partial<ResolvedEdgeNode>): ResolvedEdgeNode => ({
  kind: 'edge',
  id: 'e1',
  path: [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ],
  fromSide: 'right',
  toSide: 'left',
  fromEnd: 'none',
  toEnd: 'arrow',
  appearance: { stroke: '#404040' },
  ...overrides,
})

describe('edge arrowheads render as shared <marker> defs', () => {
  it('a to-arrow edge references an end marker and emits no inline polygon', () => {
    const svg = renderSceneToSvg({ nodes: [edge({})] })
    // The only <polygon> left is the marker's own content INSIDE <defs>;
    // the document body carries references, not per-edge triangles.
    const body = svg.slice(svg.indexOf('</defs>'))
    expect(body).not.toContain('<polygon')
    expect(svg).toContain('marker-end="url(#wb-arrow-end-_23404040)"')
    expect(svg).toContain(
      '<defs><marker id="wb-arrow-end-_23404040" markerWidth="10" markerHeight="8" refX="10" refY="4" markerUnits="userSpaceOnUse" orient="auto"><polygon points="10,4 0,0 0,8" fill="#404040"/></marker></defs>',
    )
  })

  it('a from-arrow edge references a start marker whose triangle points backwards', () => {
    const svg = renderSceneToSvg({ nodes: [edge({ fromEnd: 'arrow', toEnd: 'none' })] })
    expect(svg).toContain('marker-start="url(#wb-arrow-start-_23404040)"')
    expect(svg).toContain(
      '<marker id="wb-arrow-start-_23404040" markerWidth="10" markerHeight="8" refX="0" refY="4" markerUnits="userSpaceOnUse" orient="auto"><polygon points="0,4 10,0 10,8" fill="#404040"/></marker>',
    )
  })

  it('two same-color arrowed edges share ONE marker definition', () => {
    const svg = renderSceneToSvg({
      nodes: [
        edge({}),
        edge({
          path: [
            { x: 0, y: 50 },
            { x: 100, y: 50 },
          ],
        }),
      ],
    })
    expect(svg.match(/<marker /g)).toHaveLength(1)
    expect(svg.match(/marker-end=/g)).toHaveLength(2)
  })

  it('differently-colored arrows get separate content-derived definitions', () => {
    const svg = renderSceneToSvg({
      nodes: [edge({}), edge({ appearance: { stroke: '#111111' } })],
    })
    expect(svg).toContain('wb-arrow-end-_23404040')
    expect(svg).toContain('wb-arrow-end-_23111111')
    expect(svg.match(/<marker /g)).toHaveLength(2)
  })

  it('an end with no usable direction gets no marker reference, matching the skipped polygon', () => {
    // A coincident final segment has no direction: the polygon renderer
    // skipped the arrow, and a marker with orient="auto" would instead
    // paint one at angle 0 — a visible difference this pins against.
    const svg = renderSceneToSvg({
      nodes: [
        edge({
          path: [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 0 },
          ],
        }),
      ],
    })
    expect(svg).not.toContain('marker-end')
    expect(svg).not.toContain('<marker ')
  })

  it('a stroke-less arrowed edge keeps fill="none" markers (invisible, like the polygon it replaces)', () => {
    const svg = renderSceneToSvg({ nodes: [edge({ appearance: undefined })] })
    expect(svg).toContain('fill="none"/></marker>')
  })
})
