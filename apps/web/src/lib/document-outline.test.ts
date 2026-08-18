import type { Scene } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { outlineFromScene, outlineFromSpatial } from './document-outline.js'

const spatial = (nodes: SpatialCanvas['nodes']): SpatialCanvas => ({ nodes, edges: [] })

describe('outlineFromSpatial', () => {
  it('takes each node’s own box, in document coordinates', () => {
    expect(
      outlineFromSpatial(
        spatial([
          { id: 'a', type: 'text', x: 10, y: 20, width: 100, height: 40, text: 'hi' },
          { id: 'b', type: 'text', x: -5, y: 0, width: 60, height: 30, text: 'yo', color: '1' },
        ]),
      ),
    ).toEqual([
      // A node with no colour still gets the default fill, the same one the
      // favicon has always drawn — an outline rect is never colourless.
      { x: 10, y: 20, w: 100, h: 40, color: expect.any(String) },
      { x: -5, y: 0, w: 60, h: 30, color: expect.any(String) },
    ])
  })

  it('is empty for a canvas with no nodes', () => {
    expect(outlineFromSpatial(spatial([]))).toEqual([])
  })
})

describe('outlineFromScene', () => {
  // A markdown document has no boxes of its own; its shape is the shape its
  // BLOCKS take once laid out. Reading them off the scene is what lets one
  // outline concept serve both kinds.
  it('takes one rect per top-level block', () => {
    const scene: Scene = {
      nodes: [
        { kind: 'heading', bbox: { x: 0, y: 0, w: 300, h: 32 }, level: 1, runs: [] },
        { kind: 'paragraph', bbox: { x: 0, y: 40, w: 460, h: 48 }, runs: [] },
      ],
    }
    expect(outlineFromScene(scene)).toEqual([
      { x: 0, y: 0, w: 300, h: 32 },
      { x: 0, y: 40, w: 460, h: 48 },
    ])
  })

  // ONE rect per block — a rect per run would draw the same ink twice and
  // let a paragraph's words outvote the heading above it once the projection
  // caps by area. But the runs still decide the WIDTH: layout gives every
  // top-level block the full column width, so a block's own box says the
  // same thing for a three-word heading and a forty-word paragraph, and an
  // outline of equal bars is one worth nothing.
  it('emits one rect per block, as wide as the block’s ink rather than its box', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'paragraph',
          bbox: { x: 0, y: 0, w: 400, h: 16 },
          runs: [{ kind: 'textRun', bbox: { x: 0, y: 0, w: 40, h: 16 }, text: 'word' }],
        },
      ],
    }
    expect(outlineFromScene(scene)).toEqual([{ x: 0, y: 0, w: 40, h: 16 }])
  })

  it('takes the widest run’s right edge, not the last one’s', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'paragraph',
          bbox: { x: 0, y: 0, w: 400, h: 32 },
          runs: [
            { kind: 'textRun', bbox: { x: 0, y: 0, w: 380, h: 16 }, text: 'a long first line' },
            { kind: 'textRun', bbox: { x: 0, y: 16, w: 24, h: 16 }, text: 'end' },
          ],
        },
      ],
    }
    expect(outlineFromScene(scene)[0]?.w).toBe(380)
  })

  it('falls back to the block’s own box when it has no runs to measure', () => {
    const scene: Scene = {
      nodes: [{ kind: 'svgFragment', bbox: { x: 0, y: 0, w: 200, h: 90 }, svg: '<circle r="4"/>' }],
    }
    expect(outlineFromScene(scene)[0]?.w).toBe(200)
  })

  it('drops a block whose box is degenerate rather than emitting an invisible rect', () => {
    const scene: Scene = {
      nodes: [
        { kind: 'thematicBreak', bbox: { x: 0, y: 0, w: 400, h: 0 } },
        { kind: 'paragraph', bbox: { x: 0, y: 8, w: 400, h: 16 }, runs: [] },
        { kind: 'paragraph', bbox: { x: 0, y: Number.NaN, w: 400, h: 16 }, runs: [] },
      ],
    }
    expect(outlineFromScene(scene)).toEqual([{ x: 0, y: 8, w: 400, h: 16 }])
  })

  it('is empty for a document that laid out to nothing', () => {
    expect(outlineFromScene({ nodes: [] })).toEqual([])
  })
})
