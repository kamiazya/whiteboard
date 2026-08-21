import { describe, expect, it } from 'vitest'
import type { Scene } from '../scene-graph.js'
import { renderSceneToSvg } from './backend.js'

const scene = (
  shape?: 'ellipse' | 'diamond' | 'hexagon' | 'parallelogram' | 'cylinder',
): Scene => ({
  nodes: [
    {
      kind: 'shape',
      bbox: { x: 10, y: 20, w: 100, h: 60 },
      ...(shape === undefined ? {} : { shape }),
      appearance: { fill: '#fff', stroke: '#333' },
    },
  ],
})

describe('shape outlines in the SVG backend', () => {
  it('an absent shape field renders the historic rect byte-for-byte', () => {
    expect(renderSceneToSvg(scene())).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect x="10" y="20" width="100" height="60" fill="#fff" stroke="#333"/></svg>',
    )
  })

  it('ellipse renders an <ellipse> from the shared decomposition, appearance presence-only', () => {
    expect(renderSceneToSvg(scene('ellipse'))).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"><ellipse cx="60" cy="50" rx="50" ry="30" fill="#fff" stroke="#333"/></svg>',
    )
  })

  it('diamond renders a <polygon> from the shared decomposition', () => {
    expect(renderSceneToSvg(scene('diamond'))).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"><polygon points="60,20 110,50 60,80 10,50" fill="#fff" stroke="#333"/></svg>',
    )
  })

  it('hexagon and parallelogram render polygons from the shared decomposition', () => {
    expect(renderSceneToSvg(scene('hexagon'))).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"><polygon points="35,20 85,20 110,50 85,80 35,80 10,50" fill="#fff" stroke="#333"/></svg>',
    )
    expect(renderSceneToSvg(scene('parallelogram'))).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"><polygon points="35,20 110,20 85,80 10,80" fill="#fff" stroke="#333"/></svg>',
    )
  })

  it('cylinder renders a silhouette path plus a stroke-only lid arc', () => {
    expect(renderSceneToSvg(scene('cylinder'))).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M 10 30 A 50 10 0 0 1 110 30 L 110 70 A 50 10 0 0 1 10 70 Z" fill="#fff" stroke="#333"/>' +
        '<path d="M 10 30 A 50 10 0 0 0 110 30" fill="none" stroke="#333"/>' +
        '</svg>',
    )
  })

  it('a non-finite bbox on a shaped node renders nothing (never throws)', () => {
    const bad: Scene = {
      nodes: [{ kind: 'shape', bbox: { x: Number.NaN, y: 0, w: 1, h: 1 }, shape: 'ellipse' }],
    }
    expect(renderSceneToSvg(bad)).toBe('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  })
})
