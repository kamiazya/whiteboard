import type { CanvasEdge, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import type { SceneNode } from '../scene-graph.js'
import { renderSceneToSvg } from '../svg/backend.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import type { SpatialAppearanceResolver } from './spatial-appearance.js'
import {
  layoutSpatialCanvas,
  layoutSpatialEdges,
  naturalNodeContentSize,
  type ResolvedReference,
} from './spatial-canvas.js'

const measure = createFakeMeasure()

const appearance: SpatialAppearanceResolver = {
  resolveNode: () => ({ radius: 4 }),
  resolveEdge: () => ({ stroke: '#606060', strokeWidth: 1.5 }),
  resolveLabel: () => ({ fill: '#303030', fontFamily: 'sans-serif' }),
}

/**
 * A tiny fake mdast parser mirroring the one in spatial-canvas.test.ts:
 * `'__THROW__'` simulates a markdown construct outside the caller's
 * accepted subset, exercising `layoutSpatialCanvas`'s own body-parse
 * degradation path rather than codec's real parser (a
 * cross-package dependency this package must not take).
 */
function fakeParseBody(text: string): MdastRoot {
  if (text === '__THROW__') throw new Error('simulated unsupported mdast construct')
  return {
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
  }
}

const positionArb = fc.integer({ min: -2000, max: 2000 })
const sizeArb = fc.integer({ min: 0, max: 2000 })
const idArb = fc.stringMatching(/^[a-zA-Z0-9_-]{1,12}$/)
const textArb = fc.constantFrom('hello', 'plain body', '__THROW__', '')

/** Covers every real SpatialNode variant plus an unrecognized `type`, so the
 * property exercises every degradation path `layoutSpatialCanvas` documents
 * (body-parse failure, unknown node kind) alongside the happy paths. */
const spatialNodeArb: fc.Arbitrary<SpatialNode> = idArb.chain((id) =>
  fc.oneof(
    fc.record({
      id: fc.constant(id),
      type: fc.constant('text' as const),
      x: positionArb,
      y: positionArb,
      width: sizeArb,
      height: sizeArb,
      text: textArb,
    }),
    fc.record({
      id: fc.constant(id),
      type: fc.constant('file' as const),
      x: positionArb,
      y: positionArb,
      width: sizeArb,
      height: sizeArb,
      file: fc.constantFrom('a.md', 'notes/b.md'),
    }),
    fc.record({
      id: fc.constant(id),
      type: fc.constant('link' as const),
      x: positionArb,
      y: positionArb,
      width: sizeArb,
      height: sizeArb,
      url: fc.constant('https://example.com'),
    }),
    fc.record({
      id: fc.constant(id),
      type: fc.constant('group' as const),
      x: positionArb,
      y: positionArb,
      width: sizeArb,
      height: sizeArb,
      label: fc.option(fc.constantFrom('Section'), { nil: undefined }),
    }),
    fc
      .record({
        id: fc.constant(id),
        x: positionArb,
        y: positionArb,
        width: sizeArb,
        height: sizeArb,
      })
      .map((n) => ({ ...n, type: 'bogus' }) as unknown as SpatialNode),
  ),
)

function uniqueById(nodes: readonly SpatialNode[]): SpatialNode[] {
  const seen = new Set<string>()
  return nodes.filter((node) => {
    if (seen.has(node.id)) return false
    seen.add(node.id)
    return true
  })
}

/** Edge endpoints are drawn from a small pool that overlaps but is not
 * limited to the generated node ids, so a missing-endpoint degradation is
 * exercised alongside well-formed edges. */
const edgeArb: fc.Arbitrary<CanvasEdge> = fc.record({
  id: idArb,
  fromNode: fc.constantFrom('a', 'b', 'c', 'ghost'),
  toNode: fc.constantFrom('a', 'b', 'c', 'ghost'),
})

const spatialCanvasArb: fc.Arbitrary<SpatialCanvas> = fc
  .record({
    nodes: fc.array(spatialNodeArb, { minLength: 0, maxLength: 6 }),
    edges: fc.array(edgeArb, { minLength: 0, maxLength: 3 }),
  })
  .map(({ nodes, edges }) => ({ nodes: uniqueById(nodes), edges }))

describe('layoutSpatialCanvas properties (PBT)', () => {
  fcTest.prop([spatialCanvasArb], withDefaults())(
    'never throws and renders through renderSceneToSvg without throwing, for any generated canvas',
    (canvas) => {
      expect(() => {
        const scene = layoutSpatialCanvas(canvas, { measure, parseBody: fakeParseBody, appearance })
        renderSceneToSvg(scene, { padding: 8 })
      }).not.toThrow()
    },
  )

  fcTest.prop([spatialCanvasArb], withDefaults())(
    'composing the same canvas twice yields byte-identical SVG (determinism)',
    (canvas) => {
      const options = { measure, parseBody: fakeParseBody, appearance }
      const svgA = renderSceneToSvg(layoutSpatialCanvas(canvas, options), { padding: 4 })
      const svgB = renderSceneToSvg(layoutSpatialCanvas(canvas, options), { padding: 4 })
      expect(svgA).toBe(svgB)
    },
  )
})

/**
 * A fixed (not fc-generated) resolver keyed off `spatialNodeArb`'s file
 * pool: deterministic per file, so the property below exercises every
 * `composeFileFacets` path (usable card, degrades-to-nothing, no match)
 * across generated documents without needing its own arbitrary.
 */
function fakeResolveFacets(ref: string): ResolvedReference | undefined {
  if (ref === 'a.md') {
    return {
      facets: {
        title: 'Card',
        rows: [
          { label: 'type', value: 'note' },
          { label: 'tags', value: 'x, y' },
        ],
      },
    }
  }
  if (ref === 'notes/b.md') {
    // No usable content: degrades to the plain chrome+label rendering.
    return { facets: { rows: [] } }
  }
  return undefined
}

describe('layoutSpatialCanvas facet-card properties (PBT)', () => {
  const optionsWithFacets = {
    measure,
    parseBody: fakeParseBody,
    appearance,
    resolveReference: fakeResolveFacets,
  }

  fcTest.prop([spatialCanvasArb], withDefaults())(
    'a resolving facet resolver never throws and renders identically twice (determinism)',
    (canvas) => {
      const svgA = renderSceneToSvg(layoutSpatialCanvas(canvas, optionsWithFacets), { padding: 8 })
      const svgB = renderSceneToSvg(layoutSpatialCanvas(canvas, optionsWithFacets), { padding: 8 })
      expect(svgA).toBe(svgB)
    },
  )

  fcTest.prop([spatialCanvasArb], withDefaults())(
    'an installed-but-silent resolver changes nothing (additivity)',
    (canvas) => {
      const withNoOpSeam = layoutSpatialCanvas(canvas, {
        ...optionsWithFacets,
        resolveReference: () => undefined,
      })
      const withoutSeam = layoutSpatialCanvas(canvas, {
        measure,
        parseBody: fakeParseBody,
        appearance,
      })
      expect(withNoOpSeam).toEqual(withoutSeam)
    },
  )
})

/**
 * Keyed off the same `spatialNodeArb` file pool as the facet resolver
 * above, so generated documents exercise every `composeFileMarkdown` path:
 * a body that renders, an empty body that degrades, and a reference the
 * resolver does not know.
 */
function fakeResolveMarkdown(ref: string): ResolvedReference | undefined {
  if (ref === 'a.md') {
    return {
      markdown: {
        type: 'root',
        children: [
          { type: 'heading', depth: 2, children: [{ type: 'text', value: 'Body' }] },
          { type: 'paragraph', children: [{ type: 'text', value: 'prose that wraps somewhere' }] },
        ],
      },
    }
  }
  if (ref === 'notes/b.md') return { markdown: { type: 'root', children: [] } }
  return undefined
}

/**
 * Root-shaped bodies whose CHILDREN layout cannot dispatch on. Every one
 * passes a `{type:'root', children: unknown[]}` shape check, which is what
 * a caller validating only the envelope would apply.
 */
const malformedBodyArb: fc.Arbitrary<MdastRoot> = fc
  .array(
    fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.string(),
      fc.integer(),
      fc.record({ type: fc.constantFrom('bogus', 'heading', 'code', 'list', 'table') }),
      fc.record({ type: fc.constant('heading'), depth: fc.integer({ min: 1, max: 6 }) }),
    ),
    { minLength: 1, maxLength: 4 },
  )
  .map((children) => ({ type: 'root', children }) as unknown as MdastRoot)

describe('layoutSpatialCanvas markdown-body properties (PBT)', () => {
  const bare = { measure, parseBody: fakeParseBody, appearance }
  const withMarkdown = { ...bare, resolveReference: fakeResolveMarkdown }

  fcTest.prop([spatialCanvasArb], withDefaults())(
    'a resolving markdown resolver never throws and renders identically twice (determinism)',
    (canvas) => {
      const svgA = renderSceneToSvg(layoutSpatialCanvas(canvas, withMarkdown), { padding: 8 })
      const svgB = renderSceneToSvg(layoutSpatialCanvas(canvas, withMarkdown), { padding: 8 })
      expect(svgA).toBe(svgB)
    },
  )

  fcTest.prop([spatialCanvasArb], withDefaults())(
    'an installed-but-silent resolver changes nothing (additivity)',
    (canvas) => {
      const withNoOpSeam = layoutSpatialCanvas(canvas, {
        ...withMarkdown,
        resolveReference: () => undefined,
      })
      expect(withNoOpSeam).toEqual(layoutSpatialCanvas(canvas, bare))
    },
  )

  fcTest.prop([spatialCanvasArb], withDefaults())(
    'a resolver that always throws is indistinguishable from no resolver (totality)',
    (canvas) => {
      const withThrowingSeam = layoutSpatialCanvas(canvas, {
        ...withMarkdown,
        resolveReference: () => {
          throw new Error('simulated resolver failure')
        },
      })
      expect(withThrowingSeam).toEqual(layoutSpatialCanvas(canvas, bare))
    },
  )

  fcTest.prop([spatialCanvasArb, malformedBodyArb], withDefaults())(
    'a body that is root-shaped but structurally invalid never aborts the canvas',
    (canvas, body) => {
      // The throwing-resolver property above only covers the resolver CALL,
      // which was already guarded. This covers the return VALUE: a caller
      // whose own validation checks only `{type:'root', children:[...]}`
      // can hand over children layout cannot dispatch on, and those throw
      // from inside the layout call rather than the resolver.
      expect(() =>
        layoutSpatialCanvas(canvas, { ...bare, resolveReference: () => ({ markdown: body }) }),
      ).not.toThrow()
    },
  )

  it('degrades to the facet card when the box fits the card but not the body (pinned counterexample)', () => {
    // At 200x40 the one-line card fits the inner box but the taller markdown
    // body does not, and composeFileMarkdown's documented fall-through hands
    // the node to the card. The body outranks the card only where the body
    // can actually render — the property below states exactly that, and this
    // example pins the degradation half.
    // The size is deliberately roomy in WIDTH: the original shrunk
    // counterexample was 17px wide, which leaves a 1px content width, and a
    // width that narrow now says nothing about ranking — every body fails to
    // render there. Height is what this example is about.
    const canvas: SpatialCanvas = {
      nodes: [{ id: 'n', type: 'file', x: 0, y: 0, width: 200, height: 40, file: 'a.md' }],
      edges: [],
    }
    const text = collectRunText(
      layoutSpatialCanvas(canvas, {
        ...bare,
        resolveReference: (ref) => ({
          ...fakeResolveMarkdown(ref),
          ...fakeResolveFacets(ref),
        }),
      }).nodes,
    )
    expect(text).toContain('Card')
    expect(text).not.toContain('Body')
  })

  it('lets a small node degrade to the card while a bigger sibling renders the body', () => {
    // Two `a.md` file nodes differing only in height: 200x50 fits the
    // markdown body, 200x40 does not and falls through to the one-line card.
    // Both outcomes are correct, and a canvas-wide "no Card anywhere"
    // assertion called the pair a bug — this pins the mixed-size canvas the
    // property below now judges node by node.
    const canvas: SpatialCanvas = {
      nodes: [
        { id: 'small', type: 'file', x: 0, y: 0, width: 200, height: 40, file: 'a.md' },
        { id: 'big', type: 'file', x: 0, y: 0, width: 200, height: 50, file: 'a.md' },
      ],
      edges: [],
    }
    const text = collectRunText(
      layoutSpatialCanvas(canvas, {
        ...bare,
        resolveReference: (ref) => ({
          ...fakeResolveMarkdown(ref),
          ...fakeResolveFacets(ref),
        }),
      }).nodes,
    )
    expect(text).toContain('Body')
    expect(text).toContain('Card')
  })

  fcTest.prop([spatialCanvasArb], withDefaults())(
    'a resolved markdown body outranks a resolved facet card wherever the body can render',
    (canvas) => {
      // BOTH preconditions stated against what each single-seam layout
      // actually rendered, not against the canvas: a node too small for a
      // seam's content degrades that seam (the card on a 0x0 node; the
      // body on a box that fits the one-line card but not a paragraph —
      // the pinned 17x40 counterexample above), and asserting past either
      // guard would restate composeFileMarkdown's documented fall-through
      // as a failure.
      //
      // PER NODE, not per canvas, and attributed by laying each node out
      // ALONE. Degradation is a property of one box's size, so a canvas
      // holding a box that fits the body beside one that does not renders
      // Body for the first and Card for the second — legitimately.
      // Canvas-wide guards let that pair through and then failed on the
      // Card the small node was entitled to (seed -466764184: 17x40 beside
      // 17x44, both `a.md`), asserting the documented fall-through was a
      // bug.
      //
      // Indexing the three scenes positionally does NOT fix it: one canvas
      // node expands into several scene shapes and the count differs
      // between a card render and a body render, so the indices stop
      // lining up, both guards stop holding together, and the property
      // passes vacuously — swapping composeFileMarkdown and
      // composeFileFacets in spatial-canvas.ts left it green. A one-node
      // canvas per node is what makes the attribution exact.
      for (const node of canvas.nodes) {
        const solo: SpatialCanvas = { nodes: [node], edges: [] }
        const cardOnly = collectRunText(
          layoutSpatialCanvas(solo, { ...bare, resolveReference: fakeResolveFacets }).nodes,
        )
        if (!cardOnly.includes('Card')) continue
        const bodyOnly = collectRunText(layoutSpatialCanvas(solo, withMarkdown).nodes)
        if (!bodyOnly.includes('Body')) continue

        const both = collectRunText(
          layoutSpatialCanvas(solo, {
            ...bare,
            resolveReference: (ref) => ({
              ...fakeResolveMarkdown(ref),
              ...fakeResolveFacets(ref),
            }),
          }).nodes,
        )
        expect(both).toContain('Body')
        expect(both).not.toContain('Card')
      }
    },
  )
})

/** Every run's text anywhere in a scene, for content-level assertions. */
function collectRunText(nodes: readonly unknown[]): string[] {
  const out: string[] = []
  const visit = (node: unknown) => {
    if (node === null || typeof node !== 'object') return
    const entry = node as { kind?: string; text?: string; runs?: unknown[]; children?: unknown[] }
    if (entry.kind === 'textRun' && typeof entry.text === 'string') out.push(entry.text)
    for (const run of entry.runs ?? []) visit(run)
    for (const child of entry.children ?? []) visit(child)
  }
  for (const node of nodes) visit(node)
  return out
}

/**
 * Live-drag parity: a mid-drag preview built with `layoutSpatialEdges` over
 * the moved canvas must equal the edge-and-label suffix of the committed
 * `layoutSpatialCanvas` of that same moved canvas — detours around
 * obstacles, line jumps, and label placement included. The generator is
 * deliberately DENSE (chunky boxes on a coarse grid, edges across them,
 * jumps enabled in half the runs) so blocked paths and crossings are the
 * common case, not a lucky draw — a sparse generator would pass vacuously.
 */
const denseIds = ['a', 'b', 'c', 'd', 'e', 'f'] as const

const denseNodeArb = (id: string): fc.Arbitrary<SpatialNode> =>
  fc
    .record({
      id: fc.constant(id),
      type: fc.constantFrom('text' as const, 'group' as const),
      x: fc.constantFrom(0, 80, 160, 240, 320, 400),
      y: fc.constantFrom(0, 80, 160, 240, 320),
      width: fc.constantFrom(60, 120, 240),
      height: fc.constantFrom(60, 120, 240),
    })
    .map((n) => (n.type === 'text' ? { ...n, text: 'n' } : { ...n, label: 'G' }) as SpatialNode)

const denseEdgeArb = (index: number): fc.Arbitrary<CanvasEdge> =>
  fc
    .record({
      id: fc.constant(`e${index}`),
      fromNode: fc.constantFrom(...denseIds),
      toNode: fc.constantFrom(...denseIds),
      label: fc.option(fc.constant('flow'), { nil: undefined }),
    })
    .map(({ label, ...edge }) => (label === undefined ? edge : { ...edge, label }))

const dragScenarioArb = fc.record({
  nodes: fc.tuple(...denseIds.map(denseNodeArb)),
  edges: fc
    .array(fc.nat({ max: 4 }), { minLength: 1, maxLength: 5 })
    .chain((indices) => fc.tuple(...indices.map((_, i) => denseEdgeArb(i)))),
  routing: fc.record({
    style: fc.constantFrom(
      undefined,
      'straight' as const,
      'orthogonal' as const,
      'curved' as const,
    ),
    lineJumps: fc.constantFrom(undefined, 'arc' as const),
  }),
  carried: fc.uniqueArray(fc.constantFrom(...denseIds), { minLength: 1, maxLength: 3 }),
  dx: fc.constantFrom(-200, -80, 40, 160, 320),
  dy: fc.constantFrom(-160, -40, 80, 240),
})

describe('live-drag parity property (PBT)', () => {
  fcTest.prop([dragScenarioArb], withDefaults())(
    'mid-drag edge layout equals the committed layout of the moved canvas, obstacles and jumps included',
    ({ nodes, edges, routing, carried, dx, dy }) => {
      const carriedSet = new Set<string>(carried)
      const movedCanvas: SpatialCanvas = {
        nodes: nodes.map((n) => (carriedSet.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n)),
        edges: [...edges],
        'x-whiteboard': { edgeRouting: routing },
      }
      const options = { measure, parseBody: fakeParseBody, appearance }
      const committed = layoutSpatialCanvas(movedCanvas, options).nodes
      const live = layoutSpatialEdges(movedCanvas, options)
      expect(live.length).toBeGreaterThan(0)
      expect(live).toEqual(committed.slice(committed.length - live.length))
    },
  )
})

/**
 * The text node's vertical fit, stated as the three laws that fully describe
 * it. Example tests pin one fixture each; these say what holds for ANY body
 * in ANY box — which is the difference that matters here, because the first
 * shape of this fix passed three examples while breaking two cases nobody
 * had written an example for.
 *
 * `fullWidth` charges CJK a full em (the scoreboard's measurer, not
 * `fake-measure.ts`'s uniform 0.6em) so a wrap is reachable at these widths.
 */
const fullWidth = createFakeMeasure(1)

function parseParagraphs(text: string): MdastRoot {
  return {
    type: 'root',
    children: text.split(/\n\s*\n/).map((para) => ({
      type: 'paragraph',
      children: [{ type: 'text', value: para }],
    })),
  }
}

const fitOptions = { measure: fullWidth, parseBody: parseParagraphs, appearance }
const PADDING_PX = 8

/** The laid-out blocks, i.e. everything the node paints that is not chrome. */
function blocksOf(canvas: SpatialCanvas): ReadonlyArray<{ y: number; h: number }> {
  return layoutSpatialCanvas(canvas, fitOptions)
    .nodes.filter((entry) => entry.kind !== 'shape' && entry.kind !== 'edge')
    .map((entry) => ({ y: entry.bbox.y, h: entry.bbox.h }))
}

function textNodeAt(width: number, height: number, text: string): SpatialCanvas {
  return { nodes: [{ id: 'n', type: 'text', x: 0, y: 0, width, height, text }], edges: [] }
}

/** Bodies that wrap and bodies that do not, in one to five blocks. */
const bodyArb = fc
  .array(fc.constantFrom('かあらた', 'かたそ', 'short', 'a longer english line'), {
    minLength: 1,
    maxLength: 5,
  })
  .map((paras) => paras.join('\n\n'))

const widthArb = fc.integer({ min: 24, max: 200 })

/**
 * A fraction OF THE NATURAL CONTENT HEIGHT, never an absolute pixel range: a
 * uniform height would almost always be roomy enough to fit everything and
 * the properties would pass vacuously. Straddling 0..1.2 puts the generator
 * on both sides of every block boundary, which is where the rule lives.
 */
const fractionArb = fc.integer({ min: 0, max: 120 }).map((n) => n / 100)

/** What the body needs, measured the way the editor's grow probe measures. */
function naturalHeight(width: number, text: string): number {
  const node = textNodeAt(width, 1, text).nodes[0]
  return Math.ceil(naturalNodeContentSize(node, fitOptions).h + 2 * PADDING_PX)
}

describe('a text node fits its body to its own box (PBT)', () => {
  fcTest.prop([widthArb, bodyArb, fractionArb], withDefaults())(
    'at most one block may cross the content box, and only when none fit',
    (width, text, fraction) => {
      const height = Math.round(naturalHeight(width, text) * fraction)
      const contentBottom = height - PADDING_PX
      fc.pre(height - 2 * PADDING_PX > 0)

      const crossing = blocksOf(textNodeAt(width, height, text)).filter(
        (block) => block.y + block.h > contentBottom,
      )

      // Zero when something fits; exactly one — the first block, kept so the
      // node never renders as an empty box — when nothing does.
      expect(crossing.length).toBeLessThanOrEqual(1)
    },
  )

  fcTest.prop([widthArb, bodyArb, fractionArb], withDefaults())(
    'never renders a non-empty body as an empty box',
    (width, text, fraction) => {
      const height = Math.round(naturalHeight(width, text) * fraction)
      fc.pre(height - 2 * PADDING_PX > 0)

      expect(blocksOf(textNodeAt(width, height, text)).length).toBeGreaterThan(0)
    },
  )

  fcTest.prop([widthArb, bodyArb, fractionArb], withDefaults())(
    'the natural content size is independent of the box it is stored in',
    (width, text, fraction) => {
      // What an auto-fit needs to know cannot be a function of the box it is
      // trying to resize, or the box can never grow past what it already is.
      const height = Math.max(1, Math.round(naturalHeight(width, text) * fraction))
      const node = (h: number) => textNodeAt(width, h, text).nodes[0]

      expect(naturalNodeContentSize(node(height), fitOptions)).toEqual(
        naturalNodeContentSize(node(100_000), fitOptions),
      )
    },
  )
})

/**
 * The containment law, stated once for EVERY node kind rather than per seam.
 *
 * Several seams put content in a node's box — a text body, a resolved
 * markdown body, a facet card, an image, a scaled canvas embed, a label —
 * and each one that grew its own bound is a place the next overflow can
 * appear. So the guarantee is written against the OUTPUT: whatever a node
 * paints, wherever it came from, obeys the same rule.
 *
 * Two escapes, and they are enumerated rather than discovered:
 *
 * 1. A label placed ABOVE the frame. JSON Canvas puts a container's name
 *    outside its box, and `placeAboveNode` is the one producer of it — an
 *    element wholly above `node.y` is that label and nothing else.
 * 2. The single piece of content kept when NOTHING fits, so a node one line
 *    tall renders its line instead of an empty box.
 *
 * Only the vertical axis: horizontal overflow has its own declared
 * exemptions (inline math is neither split nor cut, an atomic run is not
 * split) and its own instrument in `text-wrapping-quality.test.ts`.
 */
const containmentShapeArb = fc.tuple(
  fc.integer({ min: 8, max: 240 }),
  fc.constantFrom(
    'かあらた\n\nかたそ',
    'a longer english line that wraps\n\nand a second block\n\nand a third',
    'short',
    '',
    '__THROW__',
  ),
  fc.constantFrom('text' as const, 'file' as const, 'link' as const, 'group' as const),
  fractionArb,
)

function containmentNode(
  width: number,
  text: string,
  type: 'text' | 'file' | 'link' | 'group',
  height: number,
): SpatialNode {
  const base = { id: 'n', x: 0, y: 0, width, height }
  if (type === 'text') return { ...base, type, text }
  if (type === 'file') return { ...base, type, file: 'md.md' }
  if (type === 'link') return { ...base, type, url: 'https://example.com' }
  return { ...base, type, label: text }
}

const containmentOptions = {
  ...fitOptions,
  resolveReference: () => ({ label: 'A referenced document' }),
}

describe('every node kind keeps its ink inside its own frame (PBT)', () => {
  /**
   * Height is drawn as a FRACTION OF THE NATURAL CONTENT HEIGHT, per kind
   * and per body — never from a flat pixel range. Measured: a flat
   * 1..160 range put roughly 1 run in 140 on a case where two blocks cross
   * the frame, so the mutation check that deletes the fit entirely passed
   * on some seeds and failed on others. Density is the fix, not more runs.
   */
  function nodeFor(
    width: number,
    text: string,
    type: 'text' | 'file' | 'link' | 'group',
    fraction: number,
  ): SpatialNode {
    const roomy = containmentNode(width, text, type, 100_000)
    const natural = naturalNodeContentSize(roomy, containmentOptions).h + 2 * PADDING_PX
    return containmentNode(width, text, type, Math.max(1, Math.round(natural * fraction)))
  }

  fcTest.prop([containmentShapeArb], withDefaults())(
    'at most one element crosses the frame bottom, once the outside label is set aside',
    ([width, text, type, fraction]) => {
      const node = nodeFor(width, text, type, fraction)
      const scene = layoutSpatialCanvas({ nodes: [node], edges: [] }, containmentOptions)
      const inFrame = scene.nodes.filter(
        (entry): entry is Exclude<SceneNode, { kind: 'edge' }> =>
          entry.kind !== 'shape' && entry.kind !== 'edge' && entry.bbox.y >= node.y,
      )
      const crossing = inFrame.filter((entry) => entry.bbox.y + entry.bbox.h > node.y + node.height)

      expect(crossing.length).toBeLessThanOrEqual(1)
    },
  )

  fcTest.prop([containmentShapeArb], withDefaults())(
    'nothing is painted above the frame except a single container label',
    ([width, text, type, fraction]) => {
      const node = nodeFor(width, text, type, fraction)
      const scene = layoutSpatialCanvas({ nodes: [node], edges: [] }, containmentOptions)
      const above = scene.nodes.filter(
        (entry): entry is Exclude<SceneNode, { kind: 'edge' }> =>
          entry.kind !== 'shape' && entry.kind !== 'edge' && entry.bbox.y < node.y,
      )

      // `placeAboveNode` emits exactly one run; a second producer of
      // outside-the-frame ink would be a new escape nobody declared.
      expect(above.length).toBeLessThanOrEqual(1)
    },
  )
})
