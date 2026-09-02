// A DOM editor overlay can own a node's text while the scene keeps drawing
// everything else. Without this, the overlay must be opaque to hide the
// committed text — and an opaque rectangle is exactly the wrong cover for a
// node whose silhouette is not a rectangle: the shape vanishes for the whole
// edit. Suppression inverts that: the scene stays the source of truth for
// the chrome (silhouette, stroke, fill), and only the text yields to the
// editor.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { layoutSpatialCanvas, type SpatialLayoutOptions } from './spatial-canvas.js'

const APPEARANCE = { resolveNode: () => ({}), resolveEdge: () => ({}), resolveLabel: () => ({}) }

function options(over?: Partial<SpatialLayoutOptions>): SpatialLayoutOptions {
  return {
    measure: createFakeMeasure(),
    parseBody: (text: string) => ({
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
    }),
    appearance: APPEARANCE,
    ...over,
  }
}

const CANVAS: SpatialCanvas = {
  nodes: [
    {
      id: 'edited',
      type: 'text',
      x: 0,
      y: 0,
      width: 200,
      height: 120,
      text: 'editedbody',
      'x-whiteboard': { facets: { 'visual.shape/v0': { kind: 'diamond' } } },
    },
    { id: 'bystander', type: 'text', x: 300, y: 0, width: 200, height: 120, text: 'bystanderbody' },
  ],
  edges: [],
}

/** Every text run's text, at any nesting depth (runs live inside blocks). */
function textsOf(scene: ReturnType<typeof layoutSpatialCanvas>): string[] {
  const out: string[] = []
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    const record = node as { kind?: string; text?: string; runs?: unknown[]; children?: unknown[] }
    if (record.kind === 'textRun' && typeof record.text === 'string') out.push(record.text)
    for (const child of record.runs ?? []) walk(child)
    for (const child of record.children ?? []) walk(child)
  }
  for (const node of scene.nodes) walk(node)
  return out
}

describe('suppressedBodyNodeIds', () => {
  it("keeps the suppressed node's chrome — silhouette included — and drops only its text", () => {
    const scene = layoutSpatialCanvas(CANVAS, options({ suppressedBodyNodeIds: ['edited'] }))
    const chrome = scene.nodes.find((node) => node.kind === 'shape' && node.id === 'edited')
    expect(chrome).toBeDefined()
    expect(chrome?.kind === 'shape' && chrome.shape).toBe('visual.diamond')
    expect(textsOf(scene).some((text) => text.startsWith('edited'))).toBe(false)
  })

  it("leaves every other node's text alone", () => {
    const scene = layoutSpatialCanvas(CANVAS, options({ suppressedBodyNodeIds: ['edited'] }))
    expect(textsOf(scene).some((text) => text.startsWith('bystander'))).toBe(true)
  })

  it('absent and empty mean the same thing: nothing suppressed', () => {
    const plain = layoutSpatialCanvas(CANVAS, options())
    const empty = layoutSpatialCanvas(CANVAS, options({ suppressedBodyNodeIds: [] }))
    expect(empty).toEqual(plain)
    expect(textsOf(plain).some((text) => text.startsWith('edited'))).toBe(true)
  })

  it('a suppressed node carries no truncation mark — there is no drawn text to truncate', () => {
    const tall: SpatialCanvas = {
      nodes: [
        {
          id: 'edited',
          type: 'text',
          x: 0,
          y: 0,
          width: 120,
          height: 40,
          text: 'line\n\nline\n\nline\n\nline\n\nline\n\nline\n\nline',
        },
      ],
      edges: [],
    }
    const scene = layoutSpatialCanvas(tall, options({ suppressedBodyNodeIds: ['edited'] }))
    const chrome = scene.nodes.find((node) => node.kind === 'shape' && node.id === 'edited')
    expect(chrome !== undefined && chrome.kind === 'shape' && chrome.truncated).not.toBe(true)
  })
})
