/**
 * Properties for `layoutMdastBlocks`.
 *
 * This is the churn hotspot of the package: every markdown-layout fix so
 * far has landed in `layoutPhrasing` or the font constants feeding it —
 * word wrap overflowing the box, an atomic inline run split mid-span, a
 * separator space dropped at a wrap point — and it was the only layout
 * module without a property test while `spatial-canvas` and `edge-routing`
 * had one each.
 *
 * The generator is LOCAL rather than canvas-model's shared
 * `mdastRootArbitrary` for one reason: density. The shared generator's
 * leaves include html/image/math/wikiLink/embed, which do not become text
 * runs at all, and its text is `fc.string()`, which almost never contains
 * a space — so wrapping would essentially never trigger and the properties
 * would pass vacuously. Text here is built from words separated by spaces,
 * against a deliberately narrow `maxWidth`, so a wrap is the common case.
 *
 * What these properties do NOT cover, verified by mutation rather than
 * assumed: the SEPARATOR-GEOMETRY defects (a trailing space lost between a
 * wrapped chunk and its next inline sibling; that same space counted
 * twice). Deleting either fix leaves all four properties green, because
 * `wrapAndPush` emits one run per word — the token sequence survives
 * intact and only the runs' x positions are wrong. Stating that as a
 * property would need to know which adjacent runs had whitespace between
 * them in the SOURCE, which the scene graph does not carry: `**a**b` and
 * `**a** b` differ only in a gap that is legitimately zero in the first
 * case. Those two defects stay on the example tests in
 * `mdast-blocks.test.ts`.
 */
import type {
  MdastFlowContent,
  MdastPhrasingContent,
  MdastRoot,
} from '@kamiazya/whiteboard-canvas-model/mdast'
import { describe, expect } from 'vitest'
import type { Scene, SceneNode, TextRunNode } from '../scene-graph.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { layoutMdastBlocks } from './mdast-blocks.js'

const measure = createFakeMeasure()
const FONT_FAMILY = 'Roboto'
/** Narrow on purpose: wide enough for a word, narrow enough that a phrase wraps. */
const MAX_WIDTH = 120

const wordArb = fc.stringMatching(/^[a-z]{1,9}$/)
/** Multi-word text is what makes wrapping reachable at all. */
const proseArb = fc.array(wordArb, { minLength: 1, maxLength: 10 }).map((words) => words.join(' '))

function phrasingArb(depth: number): fc.Arbitrary<MdastPhrasingContent> {
  const leaf = fc.oneof(
    proseArb.map((value) => ({ type: 'text', value }) as const),
    proseArb.map((value) => ({ type: 'inlineCode', value }) as const),
  )
  if (depth <= 0) return leaf
  const children = fc.array(phrasingArb(depth - 1), { minLength: 1, maxLength: 3 })
  return fc.oneof(
    leaf,
    leaf,
    children.map((c) => ({ type: 'emphasis', children: c }) as const),
    children.map((c) => ({ type: 'strong', children: c }) as const),
    children.map((c) => ({ type: 'delete', children: c }) as const),
    fc
      .record({ url: fc.webUrl(), children })
      .map(({ url, children: c }) => ({ type: 'link', url, children: c }) as const),
  )
}

const phrasingChildren = fc.array(phrasingArb(2), { minLength: 1, maxLength: 3 })

/** Blocks whose text lands in `textRun`s and nowhere else. */
const proseBlockArb: fc.Arbitrary<MdastFlowContent> = fc.oneof(
  phrasingChildren.map((children) => ({ type: 'paragraph', children }) as const),
  fc
    .record({ depth: fc.constantFrom(1, 2, 3, 4, 5, 6) as fc.Arbitrary<1 | 2 | 3 | 4 | 5 | 6> })
    .chain(({ depth }) =>
      phrasingChildren.map((children) => ({ type: 'heading', depth, children }) as const),
    ),
  phrasingChildren.map(
    (children): MdastFlowContent => ({
      type: 'blockquote',
      children: [{ type: 'paragraph', children }],
    }),
  ),
)

/**
 * Adds the block kinds that emit runs of their OWN (a list emits a bullet
 * or ordinal marker), which the text-preservation property below must not
 * see — it compares against the source text, and a marker has no source.
 */
const anyBlockArb: fc.Arbitrary<MdastFlowContent> = fc.oneof(
  proseBlockArb,
  fc.record({ ordered: fc.boolean() }).chain(({ ordered }) =>
    fc.array(phrasingChildren, { minLength: 1, maxLength: 3 }).map(
      (items) =>
        ({
          type: 'list',
          ordered,
          spread: false,
          children: items.map((children) => ({
            type: 'listItem' as const,
            spread: false,
            children: [{ type: 'paragraph' as const, children }],
          })),
        }) as const,
    ),
  ),
  fc.constant({ type: 'thematicBreak' } as const),
)

const rootOf = (blocks: readonly MdastFlowContent[]): MdastRoot => ({
  type: 'root',
  children: [...blocks],
})

const proseRootArb = fc.array(proseBlockArb, { minLength: 1, maxLength: 4 }).map(rootOf)
const anyRootArb = fc.array(anyBlockArb, { minLength: 1, maxLength: 4 }).map(rootOf)

function layout(root: MdastRoot): Scene {
  return layoutMdastBlocks(root, { measure, maxWidth: MAX_WIDTH, fontFamily: FONT_FAMILY })
}

/**
 * A scene node names its children differently per kind — `runs` on a
 * heading/paragraph/table cell, `items` on a list, `rows`/`cells` on a
 * table, `children` on a list item or blockquote. Reading only `children`
 * walks an almost-empty tree, which makes every property here pass
 * vacuously.
 */
const CHILD_KEYS = ['runs', 'items', 'children', 'rows', 'cells'] as const

/**
 * Every node in the scene with its ABSOLUTE x offset.
 *
 * The scene graph is not uniformly absolute: `listItem` and `tableCell`
 * each translate their subtree by their own `bbox.x` (decision #5 in
 * package-canvas-render.md), so a run inside one stores a wrapper-relative
 * x. Comparing that raw against `maxWidth` understates every run in a list
 * or a table, which is exactly where overflow is easiest to miss.
 */
const TRANSLATING_KINDS = new Set(['listItem', 'tableCell'])

function walk(scene: Scene): { node: SceneNode; offsetX: number }[] {
  const out: { node: SceneNode; offsetX: number }[] = []
  const visit = (nodes: readonly SceneNode[], offsetX: number) => {
    for (const node of nodes) {
      out.push({ node, offsetX })
      const record = node as unknown as Record<string, unknown>
      const childOffset = TRANSLATING_KINDS.has(node.kind)
        ? offsetX + (node as { bbox: { x: number } }).bbox.x
        : offsetX
      for (const key of CHILD_KEYS) {
        const value = record[key]
        if (Array.isArray(value)) visit(value as SceneNode[], childOffset)
      }
    }
  }
  visit(scene.nodes, 0)
  return out
}

/** Text runs with their absolute x offset, in document order. */
function textRuns(scene: Scene): { run: TextRunNode; offsetX: number }[] {
  return walk(scene)
    .filter((entry) => entry.node.kind === 'textRun')
    .map((entry) => ({ run: entry.node as TextRunNode, offsetX: entry.offsetX }))
}

const tokens = (value: string): string[] => value.split(/\s+/).filter((part) => part !== '')

function sourceTokens(node: MdastRoot | MdastFlowContent | MdastPhrasingContent): string[] {
  if ('value' in node && typeof node.value === 'string') return tokens(node.value)
  const children = (node as { children?: readonly MdastPhrasingContent[] }).children
  if (!children) return []
  return children.flatMap((child) => sourceTokens(child))
}

describe('layoutMdastBlocks properties', () => {
  fcTest.prop([anyRootArb], withDefaults())('never throws, whatever the document', (root) => {
    expect(() => layout(root)).not.toThrow()
  })

  fcTest.prop([anyRootArb], withDefaults())('produces only finite geometry', (root) => {
    for (const { node } of walk(layout(root))) {
      const { bbox } = node as { bbox?: { x: number; y: number; w: number; h: number } }
      if (bbox) {
        for (const value of [bbox.x, bbox.y, bbox.w, bbox.h]) {
          expect(Number.isFinite(value)).toBe(true)
        }
      }
      const baseline = (node as { baseline?: number }).baseline
      if (baseline !== undefined) expect(Number.isFinite(baseline)).toBe(true)
    }
  })

  // The defect this pins drew long lines straight past the node's right
  // edge. The documented exception is deliberate: a single token wider than
  // maxWidth is left overflowing rather than broken mid-word.
  fcTest.prop([anyRootArb], withDefaults())(
    'wraps every run inside maxWidth unless the run is one unbreakable token',
    (root) => {
      for (const { run, offsetX } of textRuns(layout(root))) {
        const right = offsetX + run.bbox.x + run.bbox.w
        if (right <= MAX_WIDTH + 0.001) continue
        // Two documented reasons a run may legitimately overrun: a single
        // token is never broken mid-word, and an ATOMIC run (inline code,
        // raw HTML, inline math) is never split even when it holds spaces.
        expect(tokens(run.text).length <= 1 || run.code === true).toBe(true)
      }
    },
  )

  // Wrapping decides where spaces go, so this compares TOKEN SEQUENCES
  // rather than raw strings: a line break legitimately replaces a space,
  // but neither dropping a word nor fusing two words across a wrap point
  // (the "separator space silently dropped" defect) survives it.
  fcTest.prop([proseRootArb], withDefaults())('preserves every source word, in order', (root) => {
    const rendered = textRuns(layout(root)).flatMap(({ run }) => tokens(run.text))
    expect(rendered).toStrictEqual(sourceTokens(root))
  })
})
