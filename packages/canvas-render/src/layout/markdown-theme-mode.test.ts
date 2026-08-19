// A markdown body's colour is PALETTE DATA, resolved per mode, exactly like
// every other colour in a scene (spatial-theme.ts: "Dark mode is a PARAMETER
// of this one theme"). Body runs used to carry no `fill` at all and inherit
// one from whatever ancestor the host happened to set, which put the single
// most-read colour on the canvas outside the one producer — and outside the
// contrast tests that guard the rest of it.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import type { Scene, TextRunNode } from '../scene-graph.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import { layoutSpatialCanvas } from './spatial-canvas.js'

const BODY: MdastRoot = {
  type: 'root',
  children: [
    { type: 'heading', depth: 2, children: [{ type: 'text', value: 'Head' }] },
    { type: 'paragraph', children: [{ type: 'text', value: 'prose' }] },
    {
      type: 'blockquote',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'quoted' }] }],
    },
  ],
}

function bodyRuns(mode: 'light' | 'dark'): TextRunNode[] {
  const canvas: SpatialCanvas = {
    nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 320, height: 320, text: 'x' }],
    edges: [],
  }
  const scene: Scene = layoutSpatialCanvas(canvas, {
    measure: createFakeMeasure(),
    parseBody: () => BODY,
    appearance: createSpatialTheme({ mode }),
  })
  const out: TextRunNode[] = []
  const visit = (node: unknown) => {
    if (node === null || typeof node !== 'object') return
    const entry = node as {
      kind?: string
      runs?: unknown[]
      children?: unknown[]
      items?: unknown[]
    }
    if (entry.kind === 'textRun') out.push(node as TextRunNode)
    for (const key of ['runs', 'children', 'items'] as const) {
      for (const child of entry[key] ?? []) visit(child)
    }
  }
  for (const node of scene.nodes) visit(node)
  return out
}

function quoteBlock(mode: 'light' | 'dark') {
  const canvas: SpatialCanvas = {
    nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 320, height: 320, text: 'x' }],
    edges: [],
  }
  const scene = layoutSpatialCanvas(canvas, {
    measure: createFakeMeasure(),
    parseBody: () => BODY,
    appearance: createSpatialTheme({ mode }),
  })
  const found: { appearance?: { fillOpacity?: number } }[] = []
  const visit = (node: unknown) => {
    if (node === null || typeof node !== 'object') return
    const entry = node as { kind?: string; children?: unknown[]; runs?: unknown[] }
    if (entry.kind === 'blockquote') found.push(node as { appearance?: { fillOpacity?: number } })
    for (const child of entry.children ?? []) visit(child)
    for (const run of entry.runs ?? []) visit(run)
  }
  for (const node of scene.nodes) visit(node)
  return found[0]
}

describe('a markdown body carries the mode it was rendered for', () => {
  it('gives every body run an explicit fill, in both modes', () => {
    for (const mode of ['light', 'dark'] as const) {
      const runs = bodyRuns(mode)
      expect(runs.length).toBeGreaterThan(0)
      for (const run of runs) expect(run.appearance?.fill).toBeTypeOf('string')
    }
  })

  it('resolves a different fill per mode, rather than one value for both', () => {
    const light = bodyRuns('light')[0]?.appearance?.fill
    const dark = bodyRuns('dark')[0]?.appearance?.fill
    expect(light).not.toBe(dark)
  })

  it('mutes a blockquote with opacity over that same fill, so muted tracks the mode', () => {
    // `fill-opacity` is a separate inheriting presentation attribute, so the
    // quote block can carry the muting while its runs carry the colour — a
    // run with its own `fill` still inherits the group's `fill-opacity`. That
    // is what keeps muted text muted in BOTH modes without a second colour.
    for (const mode of ['light', 'dark'] as const) {
      const quote = quoteBlock(mode)
      expect(quote?.appearance?.fillOpacity).toBeLessThan(1)
      const quoted = bodyRuns(mode).find((run) => run.text === 'quoted')
      expect(quoted?.appearance?.fill).toBe(bodyRuns(mode)[0]?.appearance?.fill)
    }
  })
})
