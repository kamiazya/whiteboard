// Every way content can vanish to keep a node inside its frame must SAY so,
// in one language. The policies differ for reasons — inline math is never
// cut, an edge label has no box to fit — but the SIGNAL differing has no
// reason, and it left the commonest case silent: three paragraphs in a box
// that holds two rendered as a tidy two-paragraph box with nothing to say a
// third existed.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import { sceneDigest } from '../scene-digest.js'
import type { Scene, ShapeSceneNode } from '../scene-graph.js'
import { createCorpusMeasure } from '../test-utils/text-wrapping-corpus.js'
import { layoutSpatialCanvas } from './spatial-canvas.js'

const APPEARANCE = {
  resolveNode: () => ({}),
  resolveEdge: () => ({}),
  resolveLabel: () => ({}),
}

const paragraph = (value: string) => ({
  type: 'paragraph' as const,
  children: [{ type: 'text' as const, value }],
})

function layout(height: number, root: MdastRoot): Scene {
  const canvas: SpatialCanvas = {
    nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 200, height, text: 'x' }],
    edges: [],
  }
  return layoutSpatialCanvas(canvas, {
    measure: createCorpusMeasure().measure,
    parseBody: () => root,
    appearance: APPEARANCE,
  })
}

/** Every text run in the scene, in paint order, with its fade flag. */
function runs(scene: Scene): ReadonlyArray<{ text: string; truncated: boolean }> {
  const out: { text: string; truncated: boolean }[] = []
  const walk = (nodes: readonly unknown[]): void => {
    for (const raw of nodes) {
      const node = raw as {
        kind: string
        text?: string
        truncated?: true
        runs?: readonly unknown[]
        children?: readonly unknown[]
        items?: readonly unknown[]
      }
      if (node.kind === 'textRun') {
        out.push({ text: node.text ?? '', truncated: node.truncated === true })
      }
      walk(node.runs ?? node.children ?? node.items ?? [])
    }
  }
  walk(scene.nodes)
  return out
}

function chrome(scene: Scene): ShapeSceneNode {
  const shape = scene.nodes.find((node): node is ShapeSceneNode => node.kind === 'shape')
  if (shape === undefined) throw new Error('no chrome shape')
  return shape
}

const THREE_PARAGRAPHS: MdastRoot = {
  type: 'root',
  children: [
    paragraph('これは段落0です。'),
    paragraph('これは段落1です。'),
    paragraph('これは段落2です。'),
  ],
}

const ONE_LONG_PARAGRAPH: MdastRoot = {
  type: 'root',
  children: [paragraph('これは十分に長い日本語の文章で、折り返すと何行にもなります。')],
}

const LIST: MdastRoot = {
  type: 'root',
  children: [
    {
      type: 'list',
      ordered: false,
      children: [0, 1, 2, 3].map((i) => ({
        type: 'listItem' as const,
        children: [paragraph(`項目${i}`)],
      })),
    },
  ],
}

describe('a node that hides content says so, however it was hidden', () => {
  it('fades the last surviving line when a whole BLOCK was dropped', () => {
    const painted = runs(layout(56, THREE_PARAGRAPHS))

    expect(painted.length).toBeGreaterThan(0)
    expect(painted.length).toBeLessThan(3)
    expect(painted.at(-1)?.truncated).toBe(true)
  })

  it('fades the last surviving line when a LINE was cut', () => {
    const painted = runs(layout(56, ONE_LONG_PARAGRAPH))

    expect(painted.at(-1)?.truncated).toBe(true)
  })

  it('fades the last surviving line when a LIST ITEM was dropped', () => {
    const painted = runs(layout(56, LIST))

    expect(painted.length).toBeGreaterThan(0)
    expect(painted.length).toBeLessThan(4)
    expect(painted.at(-1)?.truncated).toBe(true)
  })

  it('marks nothing when everything fits', () => {
    const painted = runs(layout(400, THREE_PARAGRAPHS))

    expect(painted.length).toBe(3)
    expect(painted.some((run) => run.truncated)).toBe(false)
  })
})

describe('sceneDigest reports a node whose content did not fit', () => {
  it('reports it, so a reader that cannot see a fade still knows', () => {
    // The fade is for a human looking at pixels. An agent reads the digest,
    // and until now had no way at all to learn that a node hides prose.
    const digest = sceneDigest(layout(56, THREE_PARAGRAPHS))

    expect(digest.nodes.find((node) => node.id === 'n1')?.truncated).toBe(true)
  })

  it('leaves it off a node that shows everything', () => {
    const digest = sceneDigest(layout(400, THREE_PARAGRAPHS))

    expect(digest.nodes.find((node) => node.id === 'n1')?.truncated).toBeUndefined()
  })

  it('carries the same fact the chrome does', () => {
    expect(chrome(layout(56, THREE_PARAGRAPHS)).truncated).toBe(true)
    expect(chrome(layout(400, THREE_PARAGRAPHS)).truncated).toBeUndefined()
  })
})

describe('a box too small for even ONE line', () => {
  // Keep-first says a text node never renders empty. Its unit has to be a
  // LINE: keeping the first BLOCK painted a two-line paragraph inside a
  // one-line box and reported `truncated: false`, because it counted blocks
  // and the paragraph was one. Unreachable while a line box equalled its
  // font size — a 16px line always fit the smallest box in use — and reached
  // the moment line height went to 1.5.
  const ONE_LONG_PARAGRAPH: MdastRoot = {
    type: 'root',
    children: [paragraph('これは日本語のテキストで折り返します')],
  }

  it('keeps one LINE, not the whole first block', () => {
    const painted = runs(layout(32, ONE_LONG_PARAGRAPH))

    expect(painted.length).toBe(1)
  })

  it('says so, instead of reporting a box that overflows as complete', () => {
    expect(chrome(layout(32, ONE_LONG_PARAGRAPH)).truncated).toBe(true)
    expect(runs(layout(32, ONE_LONG_PARAGRAPH)).at(-1)?.truncated).toBe(true)
  })

  it('leaves the same paragraph alone in a box that holds both lines', () => {
    const painted = runs(layout(64, ONE_LONG_PARAGRAPH))

    expect(painted.length).toBe(2)
    expect(painted.some((run) => run.truncated)).toBe(false)
    expect(chrome(layout(64, ONE_LONG_PARAGRAPH)).truncated).toBeUndefined()
  })
})
