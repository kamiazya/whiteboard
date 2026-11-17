import { facetEntries } from '@kamiazya/whiteboard-facet-engine/testing'
import type { CanvasEdge, EdgeSide, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, it } from 'vitest'
import type { EdgeAnchorOverride } from '../edge-routing.js'
import { facetsArb } from '../test-utils/facet-arbitraries.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { built } from '../test-utils/wasm/glue.js'
import { oracleLayoutCore } from '../test-utils/wasm/oracle-layout-core.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import type { SpatialLayoutOptions } from './layout-options.js'
import { layoutSpatialCanvas, layoutSpatialEdges } from './spatial-canvas.js'

/**
 * Live-drag parity, stated against the core (ADR-0054 step 7): the edge layer
 * a drag frame lays out on its own (`layoutSpatialEdges`, the `edges` query)
 * must equal the edge-and-label suffix of the scene the committed layout
 * (`layoutSpatialCanvas`) draws for the same moved canvas under the same
 * options — detours around obstacles, line jumps, colour by intent and label
 * placement included. Otherwise the drop re-draws an edge the preview never
 * showed that way.
 *
 * Both entries now share one request builder, so what this guards is the
 * core answering the two queries differently: an edges-only path that skips
 * a step the full layout takes (the canvas's theme, the tag library, a side
 * override, a facet the node or edge carries).
 *
 * The generator is deliberately DENSE — chunky boxes on a coarse grid, more
 * edges than six nodes can keep apart, jumps asked for in half the runs — so
 * blocked paths and crossings are the common case rather than a lucky draw,
 * and every facet comes off the REGISTRY for all three targets, so a facet
 * registered later arrives here with no edit. The guards below the property
 * prove it reaches what it claims: drags that move edges, the library, the
 * three facet targets, and the jump geometry.
 */
const measure = createFakeMeasure()
const appearance = createSpatialTheme({ mode: 'light' })

const denseIds = ['a', 'b', 'c', 'd', 'e', 'f'] as const
const sides: readonly EdgeSide[] = ['top', 'right', 'bottom', 'left']

const libraryArb = fc.constantFrom(undefined, {
  health: { values: { ok: { color: '4' as const }, failing: { color: '1' as const } } },
})
const tagsArb = fc.option(
  fc.constantFrom('health:ok', 'health:failing').map((tag) => [tag]),
  { nil: undefined },
)

const denseNodeArb = (id: string): fc.Arbitrary<SpatialNode> =>
  fc
    .record({
      kind: fc.constantFrom('text' as const, 'group' as const),
      x: fc.constantFrom(0, 80, 160, 240, 320, 400),
      y: fc.constantFrom(0, 80, 160, 240, 320),
      width: fc.constantFrom(60, 120, 240),
      height: fc.constantFrom(60, 120, 240),
      // Read off the registry, never listed here: what a node CARRIES is the
      // half of this parity a second entry keeps forgetting.
      facets: facetsArb(bundledFacetRegistry, 'node'),
      // A scoped tag the library may colour (ADR-0040 decision 5): a box
      // whose colour arrives by intent is an obstacle painted one way in the
      // committed scene, and the edge layer has to agree with it.
      tags: tagsArb,
    })
    .map(({ kind, facets, tags, ...box }) => {
      const fields = {
        id,
        ...box,
        ...(facets === undefined ? {} : { facets }),
        ...(tags === undefined ? {} : { tags }),
      }
      return kind === 'text'
        ? textNode({ ...fields, text: 'n' })
        : groupNode({ ...fields, label: 'G' })
    })

/**
 * Built ONCE: `facetsArbitrary` walks every facet's Zod schema at
 * construction, and rebuilding it per edge per draw puts every case over the
 * budget, which reports as a timeout that reads exactly like a failure.
 */
const edgeFacetsArb = facetsArb(bundledFacetRegistry, 'edge')

const denseEdgeArb = (index: number): fc.Arbitrary<CanvasEdge> =>
  fc
    .record({
      id: fc.constant(`e${index}`),
      from: fc.constantFrom(...denseIds).map((node) => ({ node })),
      to: fc.constantFrom(...denseIds).map((node) => ({ node })),
      label: fc.option(fc.constant('flow'), { nil: undefined }),
      // The edge's own facets: per-edge routing and the bends a contributed
      // router draws both change the geometry compared here.
      facets: edgeFacetsArb,
      tags: tagsArb,
    })
    .map(({ label, facets, tags, ...edge }) => ({
      ...edge,
      ...(label === undefined ? {} : { label }),
      ...(facets === undefined ? {} : { facets }),
      ...(tags === undefined ? {} : { tags }),
    }))

/** The routing a scenario draws with, as the `visual.edges/v0` payload's two fields. */
interface DrawnRouting {
  readonly style: 'straight' | 'orthogonal' | 'curved' | undefined
  readonly lineJumps: 'arc' | undefined
}

function withEdgesFacet(
  facets: SpatialCanvas['facets'],
  routing: DrawnRouting,
): NonNullable<SpatialCanvas['facets']> {
  const payload = {
    ...(routing.style === undefined ? {} : { routing: routing.style }),
    ...(routing.lineJumps === undefined ? {} : { lineJumps: routing.lineJumps }),
  }
  return { ...facets, 'visual.edges/v0': payload }
}

/**
 * Side overrides as the drag layer passes them (frozen bystander sides plus
 * the carried edges' cached ones): some edges pinned to a side pair, an id
 * the canvas may not hold included.
 */
const overridesArb = fc.option(
  fc
    .uniqueArray(
      fc.record({
        index: fc.nat({ max: 9 }),
        fromSide: fc.constantFrom(...sides),
        toSide: fc.constantFrom(...sides),
      }),
      { selector: ({ index }) => index, maxLength: 4 },
    )
    .map(
      (entries) =>
        new Map<string, EdgeAnchorOverride>(
          entries.map(({ index, fromSide, toSide }) => [`e${index}`, { fromSide, toSide }]),
        ),
    ),
  { nil: undefined },
)

const dragScenarioArb = fc.record({
  nodes: fc.tuple(...denseIds.map(denseNodeArb)),
  // More edges than the six nodes can keep apart, so paths cross and the
  // jump geometry is actually produced.
  edges: fc
    .array(fc.nat({ max: 4 }), { minLength: 4, maxLength: 9 })
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
  // The canvas's own facets: the theme is resolved per canvas inside the
  // layout, and an edges-only path once skipped that resolution.
  envelope: facetsArb(bundledFacetRegistry, 'canvas'),
  // A theme is drawn under `'document'` and never under the clean default.
  style: fc.constantFrom(undefined, 'document' as const),
  tagLibrary: libraryArb,
  edgeSideOverrides: overridesArb,
  carried: fc.uniqueArray(fc.constantFrom(...denseIds), { minLength: 1, maxLength: 3 }),
  dx: fc.constantFrom(-200, -80, 40, 160, 320),
  dy: fc.constantFrom(-160, -40, 80, 240),
})

type DragScenario = typeof dragScenarioArb extends fc.Arbitrary<infer T> ? T : never

function canvasOf(
  scenario: Pick<DragScenario, 'nodes' | 'edges' | 'routing'> & {
    readonly envelope: SpatialCanvas['facets']
  },
): SpatialCanvas {
  return {
    nodes: [...scenario.nodes],
    edges: [...scenario.edges],
    facets: withEdgesFacet(scenario.envelope, scenario.routing),
  }
}

/** The scenario's canvas with its carried nodes moved by the drag. */
function movedCanvasOf(scenario: DragScenario): SpatialCanvas {
  const carried = new Set<string>(scenario.carried)
  return canvasOf({
    ...scenario,
    nodes: scenario.nodes.map((n) =>
      carried.has(n.id) ? { ...n, x: n.x + scenario.dx, y: n.y + scenario.dy } : n,
    ),
  })
}

function optionsOf(
  scenario: Pick<DragScenario, 'style' | 'tagLibrary' | 'edgeSideOverrides'>,
): SpatialLayoutOptions {
  const { style, tagLibrary, edgeSideOverrides } = scenario
  return {
    measure,
    appearance,
    core: oracleLayoutCore(),
    ...(style === undefined ? {} : { style }),
    ...(tagLibrary === undefined ? {} : { tagLibrary }),
    ...(edgeSideOverrides === undefined ? {} : { edgeSideOverrides }),
  }
}

const bare = (): SpatialLayoutOptions => ({ measure, appearance, core: oracleLayoutCore() })

const SAMPLES = 200

describe.runIf(built)('live-drag parity through the core (PBT)', () => {
  fcTest.prop([dragScenarioArb], withDefaults())(
    'the edges-only layer equals the edge suffix of the committed layout',
    (scenario) => {
      const canvas = movedCanvasOf(scenario)
      const options = optionsOf(scenario)
      const committed = layoutSpatialCanvas(canvas, options).nodes
      const live = layoutSpatialEdges(canvas, options)
      expect(live.length).toBeGreaterThan(0)
      expect(live).toEqual(committed.slice(committed.length - live.length))
    },
  )

  it('draws drags that actually move the edges it compares', () => {
    // A drag that leaves every edge where it was compares the resting layout
    // with itself and proves nothing about a FRAME. Measured: 193-195 of 200.
    const moving = fc.sample(dragScenarioArb, SAMPLES).filter((scenario) => {
      const options = optionsOf(scenario)
      const resting = layoutSpatialEdges(canvasOf(scenario), options)
      const dragged = layoutSpatialEdges(movedCanvasOf(scenario), options)
      return JSON.stringify(resting) !== JSON.stringify(dragged)
    })
    expect(moving.length).toBeGreaterThanOrEqual(150)
  })

  it('every registered node, canvas and edge facet is drawn by the generator', () => {
    for (const target of ['node', 'canvas', 'edge'] as const) {
      const seen = new Set<string>()
      for (const facets of fc.sample(facetsArb(bundledFacetRegistry, target), 300)) {
        for (const key of Object.keys(facets ?? {})) seen.add(key)
      }
      const registered = facetEntries(bundledFacetRegistry, target).map((entry) => entry.key)
      expect(registered.length, target).toBeGreaterThan(0)
      expect([...seen].sort(), target).toEqual(registered.sort())
    }
  })

  it('the library the generator draws changes the edges it compares', () => {
    const library = {
      health: { values: { ok: { color: '4' as const }, failing: { color: '1' as const } } },
    }
    const moved = fc.sample(dragScenarioArb, SAMPLES).filter((scenario) => {
      const canvas = canvasOf(scenario)
      const withLibrary = layoutSpatialEdges(canvas, { ...bare(), tagLibrary: library })
      return JSON.stringify(withLibrary) !== JSON.stringify(layoutSpatialEdges(canvas, bare()))
    })
    // Measured: 200 of 200.
    expect(moved.length).toBeGreaterThanOrEqual(150)
  })

  it('the side overrides the generator draws change the edges it compares', () => {
    const moved = fc.sample(dragScenarioArb, SAMPLES).filter((scenario) => {
      if (scenario.edgeSideOverrides === undefined) return false
      const canvas = canvasOf(scenario)
      const pinned = { ...bare(), edgeSideOverrides: scenario.edgeSideOverrides }
      return (
        JSON.stringify(layoutSpatialEdges(canvas, pinned)) !==
        JSON.stringify(layoutSpatialEdges(canvas, bare()))
      )
    })
    // Measured: 91-110 of 200 (half the scenarios draw no overrides).
    expect(moved.length).toBeGreaterThanOrEqual(50)
  })

  it('the canvas facets the generator draws change the layout it compares', () => {
    const options = { ...bare(), style: 'document' as const }
    const moved = fc.sample(dragScenarioArb, SAMPLES).filter((scenario) => {
      const canvas = canvasOf(scenario)
      const stripped = canvasOf({ ...scenario, envelope: undefined })
      return (
        JSON.stringify(layoutSpatialCanvas(canvas, options).nodes) !==
        JSON.stringify(layoutSpatialCanvas(stripped, options).nodes)
      )
    })
    // Measured: 93-107 of 200.
    expect(moved.length).toBeGreaterThanOrEqual(50)
  })

  it('the node facets the generator draws change the layout it compares', () => {
    const moved = fc.sample(dragScenarioArb, SAMPLES).filter((scenario) => {
      const canvas = canvasOf({ ...scenario, envelope: undefined })
      const stripped: SpatialCanvas = {
        ...canvas,
        nodes: canvas.nodes.map(({ facets: _facets, ...node }) => node as SpatialNode),
      }
      return (
        JSON.stringify(layoutSpatialCanvas(canvas, bare()).nodes) !==
        JSON.stringify(layoutSpatialCanvas(stripped, bare()).nodes)
      )
    })
    // Measured: 200 of 200.
    expect(moved.length).toBeGreaterThanOrEqual(150)
  })

  it('the edge facets the generator draws change the layout it compares', () => {
    const moved = fc.sample(dragScenarioArb, SAMPLES).filter((scenario) => {
      const canvas = canvasOf({ ...scenario, envelope: undefined })
      const stripped: SpatialCanvas = {
        ...canvas,
        edges: canvas.edges.map(({ facets: _facets, ...edge }) => edge as CanvasEdge),
      }
      return (
        JSON.stringify(layoutSpatialCanvas(canvas, bare()).nodes) !==
        JSON.stringify(layoutSpatialCanvas(stripped, bare()).nodes)
      )
    })
    // Measured: 196-198 of 200.
    expect(moved.length).toBeGreaterThanOrEqual(150)
  })

  it('the scenario reaches the jump geometry it claims to cover', () => {
    const withJumps = fc.sample(dragScenarioArb, SAMPLES).filter((scenario) =>
      layoutSpatialEdges(
        canvasOf({
          ...scenario,
          envelope: undefined,
          routing: { ...scenario.routing, lineJumps: 'arc' },
        }),
        bare(),
      ).some((node) => node.kind === 'edge' && (node.jumps?.length ?? 0) > 0),
    )
    // Drawn only where two routes actually cross: a floor on the arrangement.
    // Measured: 52-60 of 200.
    expect(withJumps.length).toBeGreaterThanOrEqual(30)
  })
})
