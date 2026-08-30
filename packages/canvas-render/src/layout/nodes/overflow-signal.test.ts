// Every way content can vanish to keep a node inside its frame must SAY so,
// in one language. The policies differ for reasons — inline math is never
// cut, an edge label has no box to fit — but the SIGNAL differing has no
// reason, and it left the commonest case silent: three paragraphs in a box
// that holds two rendered as a tidy two-paragraph box with nothing to say a
// third existed.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import { sceneDigest } from '../../scene-digest.js'
import type { Scene, ShapeSceneNode } from '../../scene-graph.js'
import { createCorpusMeasure } from '../../test-utils/text-wrapping-corpus.js'
import { SPATIAL_THEME_GEOMETRY } from '../../theme/spatial-geometry.js'
import { layoutSpatialCanvas } from '../spatial-canvas.js'
import { BODY_LINE_HEIGHT_PX } from './mdast-blocks.js'

const APPEARANCE = {
  resolveNode: () => ({}),
  resolveEdge: () => ({}),
  resolveLabel: () => ({}),
}

const paragraph = (value: string) => ({
  type: 'paragraph' as const,
  children: [{ type: 'text' as const, value }],
})

function layoutSized(width: number, height: number, root: MdastRoot): Scene {
  const canvas: SpatialCanvas = {
    nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width, height, text: 'x' }],
    edges: [],
  }
  return layoutSpatialCanvas(canvas, {
    measure: createCorpusMeasure().measure,
    parseBody: () => root,
    appearance: APPEARANCE,
  })
}

function layout(height: number, root: MdastRoot): Scene {
  return layoutSized(200, height, root)
}

/** Every text run in the scene, in paint order, with its fade flag. */
function runs(
  scene: Scene,
): ReadonlyArray<{ text: string; truncated: boolean; overflows: boolean }> {
  const out: { text: string; truncated: boolean; overflows: boolean }[] = []
  const walk = (nodes: readonly unknown[]): void => {
    for (const raw of nodes) {
      const node = raw as {
        kind: string
        text?: string
        truncated?: true
        overflows?: true
        runs?: readonly unknown[]
        children?: readonly unknown[]
        items?: readonly unknown[]
      }
      if (node.kind === 'textRun') {
        out.push({
          text: node.text ?? '',
          truncated: node.truncated === true,
          overflows: node.overflows === true,
        })
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

  // Derived, not pinned: the box that "holds both lines" is a fact about the
  // theme's line height plus the node padding, and a literal stops being that
  // box the moment either moves.
  const TWO_LINE_BOX_PX = Math.ceil(2 * BODY_LINE_HEIGHT_PX + 2 * SPATIAL_THEME_GEOMETRY.paddingPx)

  it('leaves the same paragraph alone in a box that holds both lines', () => {
    const painted = runs(layout(TWO_LINE_BOX_PX, ONE_LONG_PARAGRAPH))

    expect(painted.length).toBe(2)
    expect(painted.some((run) => run.truncated)).toBe(false)
    expect(chrome(layout(TWO_LINE_BOX_PX, ONE_LONG_PARAGRAPH)).truncated).toBeUndefined()
  })
})

describe('a run cut sideways is hidden content too', () => {
  // A code line and an atomic inline run cannot wrap, so keeping them inside
  // the box means CUTTING them. That is the same loss as a dropped block and
  // owes the same signal — counting only dropped blocks left it silent.
  const wideCode: MdastRoot = {
    type: 'root',
    children: [
      {
        type: 'code',
        lang: null,
        meta: null,
        value: 'const veryLongIdentifierName = computeSomething(alpha, beta, gamma)',
      },
    ],
  }

  it('reports the node as truncated even when every block fits vertically', () => {
    const scene = layout(400, wideCode)
    const shape = scene.nodes.find((node) => node.kind === 'shape') as ShapeSceneNode | undefined
    expect(shape?.truncated).toBe(true)
  })

  it('reaches sceneDigest, which is what an agent reads', () => {
    const digest = sceneDigest(layout(400, wideCode))
    expect(digest.nodes.find((node) => node.id === 'n1')?.truncated).toBe(true)
  })

  it('stays quiet when nothing was cut', () => {
    const scene = layout(400, { type: 'root', children: [paragraph('short')] })
    const shape = scene.nodes.find((node) => node.kind === 'shape') as ShapeSceneNode | undefined
    expect(shape?.truncated).toBeUndefined()
  })
})

describe('a node too narrow for content that is nonetheless all there', () => {
  // The one case where "there is more of this than you can see" and "this
  // does not fit its box" disagree, and the reason they are two flags. An
  // atomic run of ONE code point cannot be cut any further, so it is kept
  // whole and painted overflowing its box. Nothing is hidden — the fade and
  // `sceneDigest.truncated` would both be lying — but the box is still too
  // small, which is exactly what `wb_canvas_snapshot`'s `overflows` reports
  // and what a reader would act on.
  //
  // Found by a property over `fitToWidth`, which shrank it to `(' ', 1)`.
  const ONE_WIDE_CODE_SPAN: MdastRoot = {
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'inlineCode', value: '國' }] }],
  }

  // Wide enough that the content box is usable (below ~24px it collapses to
  // nothing, which `fitToWidth` reads as "no width to fit against" and
  // answers by returning the text untouched), narrow enough that one
  // full-width glyph does not fit it.
  const NARROW_PX = 30

  const narrow = () => layoutSized(NARROW_PX, 200, ONE_WIDE_CODE_SPAN)

  it('keeps the whole code point rather than dropping it', () => {
    const painted = runs(narrow())

    expect(painted.map((run) => run.text)).toEqual(['國'])
  })

  it('says it overflows and does NOT say it was truncated', () => {
    const painted = runs(narrow())

    expect(painted.at(-1)?.overflows).toBe(true)
    expect(painted.at(-1)?.truncated).toBe(false)
  })

  it('carries both answers up to the chrome the digest reads', () => {
    expect(chrome(narrow()).overflows).toBe(true)
    expect(chrome(narrow()).truncated).toBeUndefined()
  })

  it('reports it to an agent as overflowing, not as hiding prose', () => {
    const node = sceneDigest(narrow()).nodes.find((entry) => entry.id === 'n1')

    expect(node?.overflows).toBe(true)
    expect(node?.truncated).toBeUndefined()
  })

  it('reports BOTH when content is genuinely dropped, so overflows is the weaker claim', () => {
    // `truncated` implies `overflows` everywhere: content that was cut did
    // not fit either. A reader can therefore treat `overflows` alone as the
    // "is this box big enough" question and never miss a case.
    const node = sceneDigest(layout(56, THREE_PARAGRAPHS)).nodes.find((e) => e.id === 'n1')

    expect(node?.truncated).toBe(true)
    expect(node?.overflows).toBe(true)
  })

  it('says neither when the same span has room', () => {
    const roomy = layoutSized(200, 200, ONE_WIDE_CODE_SPAN)

    expect(chrome(roomy).overflows).toBeUndefined()
    expect(chrome(roomy).truncated).toBeUndefined()
    expect(runs(roomy).some((run) => run.overflows || run.truncated)).toBe(false)
  })
})
