// @vitest-environment node

import { referenceSeams } from '@kamiazya/whiteboard-canvas-render'
import { createFixedMeasure } from '@kamiazya/whiteboard-canvas-render/test-utils'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { layoutWithFragments } from '../fragment-requests.js'
import { renderCanvasForExport } from './scene-render.js'
import { renderCanvasForExportWith, renderCanvasToSvgWith } from './scene-render-core.js'

const measure = createFixedMeasure({ advance: (text) => text.length * 6, ascent: 10, descent: 2 })

const NOTE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

const MATH_FRAGMENT = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="10"><path data-probe="math-drawn" d="M0 0h40"/></svg>',
  width: 40,
  height: 10,
}
const DIAGRAM_FRAGMENT = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="10"><path data-probe="diagram-drawn" d="M0 0h40"/></svg>',
  width: 40,
  height: 10,
}

const mathBoard: SpatialCanvas = {
  nodes: [textNode({ id: 'a', x: 0, y: 0, width: 240, height: 120, text: '$$\nx^2\n$$\n' })],
  edges: [],
}

describe('renderCanvasToSvgWith', () => {
  it("draws a text node's math block from the fragment table it is handed", () => {
    const onFragmentsAsked = vi.fn()
    const { svg } = renderCanvasToSvgWith(mathBoard, {
      measure,
      fragments: [['math:x^2', MATH_FRAGMENT]],
      onFragmentsAsked,
    })
    expect(svg).toContain('math-drawn')
    expect(onFragmentsAsked).not.toHaveBeenCalled()
  })

  it('hands the sources its table lacks to onFragmentsAsked, drawing their fallback', () => {
    const board: SpatialCanvas = {
      nodes: [
        textNode({
          id: 'a',
          x: 0,
          y: 0,
          width: 240,
          height: 120,
          text: '```mermaid\ngraph TD; A-->B\n```\n',
        }),
      ],
      edges: [],
    }
    const onFragmentsAsked = vi.fn()
    const { svg } = renderCanvasToSvgWith(board, { measure, fragments: [], onFragmentsAsked })
    expect(svg).not.toContain('diagram-drawn')
    expect(onFragmentsAsked).toHaveBeenCalledWith([
      { kind: 'diagram', lang: 'mermaid', value: 'graph TD; A-->B' },
    ])
    const drawn = renderCanvasToSvgWith(board, {
      measure,
      fragments: [['fence:mermaid:graph TD; A-->B', DIAGRAM_FRAGMENT]],
    })
    expect(drawn.svg).toContain('diagram-drawn')
  })
})

describe('renderCanvasForExport through layoutWithFragments', () => {
  it("waits for a text node's math and a file node's note fence before drawing", async () => {
    const board: SpatialCanvas = {
      nodes: [
        ...mathBoard.nodes,
        fileNode({ id: 'f', x: 300, y: 0, width: 260, height: 160, file: NOTE_ID }),
      ],
      edges: [],
    }
    const math = vi.fn(async () => MATH_FRAGMENT)
    const diagram = vi.fn(async () => DIAGRAM_FRAGMENT)
    const references = referenceSeams(
      new Map([[NOTE_ID, { name: 'Note', body: '```mermaid\ngraph TD; C-->D\n```\n' }]]),
    )
    const { svg } = await layoutWithFragments(
      (table) => renderCanvasForExport(board, { measure, references, ...table }),
      { math, diagram },
    )
    expect(math).toHaveBeenCalledTimes(1)
    expect(diagram).toHaveBeenCalledTimes(1)
    expect(diagram).toHaveBeenCalledWith('mermaid', 'graph TD; C-->D')
    expect(svg).toContain('math-drawn')
    expect(svg).toContain('diagram-drawn')
  })
})

describe('renderCanvasForExportWith', () => {
  it('leaves the same margin on every side of what it draws', () => {
    const board: SpatialCanvas = {
      nodes: [textNode({ id: 'a', x: 40, y: 30, width: 200, height: 80, text: 'Box' })],
      edges: [],
    }
    const { bounds } = renderCanvasForExportWith(board, { measure })
    const left = 40 - bounds.x
    const top = 30 - bounds.y
    const right = bounds.x + bounds.w - 240
    const bottom = bounds.y + bounds.h - 110
    expect(Math.min(left, top, right, bottom)).toBeGreaterThanOrEqual(16)
    expect(right).toBeCloseTo(left)
    expect(bottom).toBeCloseTo(top)
  })
})
