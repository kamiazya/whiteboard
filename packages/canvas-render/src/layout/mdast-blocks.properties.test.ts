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
 * The generator is LOCAL rather than model's shared
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
 * twice). Deleting either fix leaves these properties green, because
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
} from '@kamiazya/whiteboard-model/mdast'
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

/**
 * The verbatim source text of every ATOMIC run — inline code, raw HTML,
 * inline math. Only these are ever truncated (prose wraps instead), so this
 * is the exact set a cut run's text must be a prefix of.
 */
function atomicValues(node: MdastRoot | MdastFlowContent | MdastPhrasingContent): string[] {
  const type = (node as { type?: string }).type
  const value = (node as { value?: unknown }).value
  if (
    typeof value === 'string' &&
    (type === 'inlineCode' || type === 'html' || type === 'inlineMath')
  ) {
    return [value]
  }
  const children = (node as { children?: readonly MdastPhrasingContent[] }).children
  return children ? children.flatMap((child) => atomicValues(child)) : []
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
  // edge. Only two documented exceptions remain, and both are irreducible:
  // there is nothing below a single code point to split, and an ATOMIC run
  // (inline code, raw HTML, inline math) is never split because an interior
  // space in it is not a word boundary.
  fcTest.prop([anyRootArb], withDefaults())(
    'wraps every run inside maxWidth unless it is one code point or atomic',
    (root) => {
      for (const { run, offsetX } of textRuns(layout(root))) {
        const right = offsetX + run.bbox.x + run.bbox.w
        if (right <= MAX_WIDTH + 0.001) continue
        expect([...run.text].length <= 1 || run.code === true).toBe(true)
      }
    },
  )

  /**
   * The rendered tokens re-joined wherever wrapping split ONE source token
   * across a break — legitimate since a token with no break opportunity in it
   * is broken by code point rather than left to overflow. A dropped word
   * still comes out short, and two words fused across a wrap point (the
   * "separator space silently dropped" defect) still come out over-long.
   */
  function rejoinSplitTokens(rendered: readonly string[], source: readonly string[]): string[] {
    const out: string[] = []
    let index = 0
    for (const want of source) {
      let joined = ''
      while (index < rendered.length && joined.length < want.length) {
        joined += rendered[index]
        index += 1
      }
      out.push(joined)
    }
    out.push(...rendered.slice(index))
    return out
  }

  // Wrapping decides where spaces go, so this compares TOKEN SEQUENCES
  // rather than raw strings: a line break legitimately replaces a space.
  //
  // A TRUNCATED run is the one place text is deliberately dropped, so a
  // document containing one is held to the weaker statement its contract
  // actually makes: what survives is a PREFIX. Stated as two properties
  // rather than one weakened property, so the un-truncated case — every
  // document with no atomic overflow in it, which is nearly all of them —
  // keeps the full strength it had.
  fcTest.prop([proseRootArb], withDefaults())('preserves every source word, in order', (root) => {
    const runs = textRuns(layout(root))
    if (runs.some(({ run }) => run.truncated === true)) return
    const rendered = runs.flatMap(({ run }) => tokens(run.text))
    expect(rejoinSplitTokens(rendered, sourceTokens(root))).toStrictEqual(sourceTokens(root))
  })

  fcTest.prop([proseRootArb], withDefaults())('only ever cuts a run to a prefix', (root) => {
    for (const { run } of textRuns(layout(root))) {
      if (run.truncated !== true) continue
      // The WHOLE retained text, not just its first token: a truncator that
      // corrupts anything after the first word would satisfy a per-token
      // check while painting text that was never in the document.
      expect(atomicValues(root).some((value) => value.startsWith(run.text))).toBe(true)
    }
  })

  // XML — and therefore an SVG <text> element — strips leading/trailing
  // whitespace and squeezes interior whitespace to one space, so a run
  // whose TEXT is not already in that collapsed form paints its glyphs
  // left of where layout measured them ("`code` and" as "codeand").
  // Generator note: prose text elsewhere in this file never carries
  // boundary whitespace, so this property pads its own text leaves — an
  // unpadded generator passes vacuously (mutation-checked).
  const padArb = fc.constantFrom('', ' ', '  ', '\n')
  const paddedTextArb = fc.tuple(padArb, proseArb, padArb).map(
    ([lead, core, trail]): MdastPhrasingContent => ({
      type: 'text',
      value: `${lead}${core}${trail}`,
    }),
  )
  const paddedChildrenArb = fc.array(
    fc.oneof(
      paddedTextArb,
      proseArb.map((value): MdastPhrasingContent => ({ type: 'inlineCode', value })),
      paddedTextArb.map((text): MdastPhrasingContent => ({ type: 'strong', children: [text] })),
      paddedTextArb.map(
        (text): MdastPhrasingContent => ({
          type: 'link',
          url: 'https://example.com',
          children: [text],
        }),
      ),
    ),
    { minLength: 1, maxLength: 4 },
  )
  const paddedRootArb = paddedChildrenArb.map((children) =>
    rootOf([{ type: 'paragraph', children }]),
  )

  fcTest.prop([paddedRootArb], withDefaults())(
    'every prose run is XML-collapse-stable (no boundary whitespace, single interior spaces)',
    (root) => {
      for (const { run } of textRuns(layout(root))) {
        // Atomic runs (inline code) keep their source text verbatim by
        // contract and are exempt.
        if (run.code === true) continue
        expect(run.text).not.toBe('')
        expect(run.text).toBe(run.text.trim().replace(/\s+/g, ' '))
      }
    },
  )

  // Embed recursion totality: a small fixed id pool keeps the generated
  // graphs DENSE in cycles and self-references — a sparse generator would
  // never reach the arrangements the cap and cycle guards exist for.
  const EMBED_IDS = Array.from({ length: 6 }, (_, i) => `01ARZ3NDEKTSV4RRFFQ69G5FA${i}`)
  const embedGraphArb = fc.dictionary(
    fc.constantFrom(...EMBED_IDS),
    fc.array(fc.constantFrom(...EMBED_IDS), { minLength: 0, maxLength: 4 }),
    { minKeys: 1, maxKeys: 6 },
  )

  fcTest.prop([embedGraphArb, fc.constantFrom(...EMBED_IDS)], withDefaults())(
    'terminates on any embed graph, nesting embedResolved at most the depth cap deep',
    (graph, rootId) => {
      const docOf = (id: string): MdastRoot =>
        rootOf(
          (graph[id] ?? []).map(
            (child) =>
              ({ type: 'paragraph', children: [{ type: 'embed', documentId: child }] }) as const,
          ),
        )
      const scene = layoutMdastBlocks(docOf(rootId), {
        measure,
        maxWidth: MAX_WIDTH,
        fontFamily: FONT_FAMILY,
        resolveEmbed: (id) => (graph[id] ? { root: docOf(id) } : undefined),
      })
      // Two guards, two assertions — the cap alone also bounds nesting, so
      // asserting depth by itself passes with the cycle guard deleted
      // (mutation-checked): the path-local re-visit rule needs its own claim.
      const inspect = (nodes: readonly SceneNode[], path: readonly string[]): number => {
        let deepest = path.length
        for (const node of nodes) {
          const children = (node as { children?: readonly SceneNode[] }).children
          if (!Array.isArray(children)) continue
          let childPath = path
          if (node.kind === 'embedResolved') {
            expect(path).not.toContain(node.documentId)
            childPath = [...path, node.documentId]
          }
          deepest = Math.max(deepest, inspect(children, childPath))
        }
        return deepest
      }
      expect(inspect(scene.nodes, [])).toBeLessThanOrEqual(3)
    },
  )
})
