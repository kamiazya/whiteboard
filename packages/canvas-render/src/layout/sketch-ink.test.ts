// The theme decides whether a canvas is inked; the layout assigns the ink
// as a KIND plus a seed on the scene node, never coordinates, so
// translate/scale need no knowledge of it and the digest keeps reading the
// semantic box.

import { SAMPLE_THEME_TOKENS, type ThemeTokens } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { ResolvedEdgeNode, Scene, ShapeSceneNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { sceneDigest } from '../scene-digest.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import { seedFromId } from './seed.js'
import {
  layoutSpatialCanvas,
  type RenderContribution,
  type SpatialLayoutOptions,
} from './spatial-canvas.js'

const PENCIL: ThemeTokens = { ...SAMPLE_THEME_TOKENS, ink: 'sketch', defaults: {} }
const CRISP: ThemeTokens = { ...SAMPLE_THEME_TOKENS, ink: 'clean', defaults: {} }

const DEMO: RenderContribution = {
  namespace: 'demo',
  themes: { pencil: PENCIL, crisp: CRISP },
}

function options(over?: Partial<SpatialLayoutOptions>): SpatialLayoutOptions {
  return {
    measure: createFakeMeasure(),
    parseBody: () => ({ type: 'root', children: [] }),
    appearance: createSpatialTheme({ mode: 'light' }),
    renderContributions: [DEMO],
    ...over,
  }
}

const canvas: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 0, y: 0, width: 100, height: 60, text: 'a', color: '5' }),
    textNode({ id: 'b', x: 300, y: 200, width: 100, height: 60, text: 'b' }),
  ],
  edges: [
    {
      id: 'e',
      from: { node: 'a' },
      to: { node: 'b' },
    },
  ],
  comments: [{ id: 'k', x: 50, y: 30, text: 'note', targetNodeId: 'a' }],
}

const shapes = (scene: Scene) => scene.nodes.filter((n): n is ShapeSceneNode => n.kind === 'shape')
const edges = (scene: Scene) => scene.nodes.filter((n): n is ResolvedEdgeNode => n.kind === 'edge')

describe('sketch ink assignment', () => {
  it('a sketch theme inks every document node and edge with a seed from its id', () => {
    const scene = layoutSpatialCanvas(canvas, options({ style: 'demo.pencil' }))
    const a = shapes(scene).find((s) => s.id === 'a')
    const b = shapes(scene).find((s) => s.id === 'b')
    expect(a?.ink).toEqual({ style: 'sketch', seed: seedFromId('a'), fill: 'hatch' })
    expect(b?.ink).toEqual({ style: 'sketch', seed: seedFromId('b') })
    expect(edges(scene).find((e) => e.id === 'e')?.ink).toEqual({
      style: 'sketch',
      seed: seedFromId('e'),
    })
  })

  it('a coloured group frame is inked but never hatched — a container is not a filled box', () => {
    const framed: SpatialCanvas = {
      ...canvas,
      nodes: [
        groupNode({ id: 'g', x: -20, y: -20, width: 400, height: 300, label: 'G', color: '2' }),
        ...canvas.nodes,
      ],
    }
    const scene = layoutSpatialCanvas(framed, options({ style: 'demo.pencil' }))
    expect(shapes(scene).find((s) => s.id === 'g')?.ink).toEqual({
      style: 'sketch',
      seed: seedFromId('g'),
    })
  })

  it('a clean theme, and no theme, assign no ink', () => {
    for (const style of ['demo.crisp', 'clean'] as const) {
      const scene = layoutSpatialCanvas(canvas, options({ style }))
      expect(shapes(scene).every((s) => s.ink === undefined)).toBe(true)
      expect(edges(scene).every((e) => e.ink === undefined)).toBe(true)
    }
  })

  it('comment chrome stays crisp — the annotation layer must read as chrome, not content', () => {
    const scene = layoutSpatialCanvas(canvas, options({ style: 'demo.pencil' }))
    const chrome = scene.nodes.filter((n) => n.kind === 'shape' && n.commentChrome === true)
    expect(chrome.length).toBeGreaterThan(0)
    expect(chrome.every((n) => n.kind === 'shape' && n.ink === undefined)).toBe(true)
    const leaders = edges(scene).filter((e) => e.commentChrome === true)
    expect(leaders.every((e) => e.ink === undefined)).toBe(true)
  })

  it('ink changes nothing the digest reads', () => {
    const inked = layoutSpatialCanvas(canvas, options({ style: 'demo.pencil' }))
    const crisp = layoutSpatialCanvas(canvas, options({ style: 'demo.crisp' }))
    expect(sceneDigest(inked)).toEqual(sceneDigest(crisp))
  })
})
