// A canvas's render theme is resolved HERE, per canvas, from the canvas
// being laid out — the same site `visual.edges` is read — never pushed in as
// a layout option and spread downward (ADR-0030 decision 5). What a theme
// changes is paint and defaults; what it never changes is a silhouette or
// route somebody chose explicitly (decision 4).
import { SAMPLE_THEME_TOKENS, type ThemeTokens } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type {
  EmbedResolvedNode,
  ResolvedEdgeNode,
  Scene,
  ShapeSceneNode,
  TextRunNode,
} from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import {
  layoutSpatialCanvas,
  type RenderContribution,
  type SpatialLayoutDegradation,
  type SpatialLayoutOptions,
} from './spatial-canvas.js'

const THEME_KEY = 'demo.theme/v0'

/** A theme whose light stroke is unmistakable, with a default shape and routing. */
const CHALK: ThemeTokens = {
  ...SAMPLE_THEME_TOKENS,
  palette: {
    light: {
      ...SAMPLE_THEME_TOKENS.palette.light,
      node: {
        ...SAMPLE_THEME_TOKENS.palette.light.node,
        text: { fill: '#fffdf7', stroke: '#123456' },
        group: { fill: 'none', stroke: '#654321' },
      },
      edgeStroke: '#abcdef',
    },
    dark: {
      ...SAMPLE_THEME_TOKENS.palette.dark,
      node: {
        ...SAMPLE_THEME_TOKENS.palette.dark.node,
        text: { fill: 'none', stroke: '#fedcba' },
      },
    },
  },
  defaults: {
    edgeRouting: 'curved',
    nodeShape: 'demo.triangle',
    groupFrame: { strokeDasharray: '7 5', strokeWidth: 1.5 },
  },
}

const TRIANGLE = {
  outline: (box: { x: number; y: number; w: number; h: number }) =>
    ({
      kind: 'polygon',
      points: [
        { x: box.x, y: box.y + box.h },
        { x: box.x + box.w, y: box.y + box.h },
        { x: box.x + box.w, y: box.y },
      ],
    }) as const,
}

const DEMO: RenderContribution = {
  namespace: 'demo',
  shapes: { triangle: TRIANGLE, square: { outline: () => null } },
  readShape: (node) => {
    const stored = node['x-whiteboard']?.facets?.['demo.shape/v0']
    return typeof stored === 'object' && stored !== null
      ? (stored as { kind?: string }).kind
      : undefined
  },
  themes: { chalk: CHALK },
  readTheme: (canvas) => {
    const stored = canvas['x-whiteboard']?.facets?.[THEME_KEY]
    return typeof stored === 'object' && stored !== null
      ? (stored as { theme?: string }).theme
      : undefined
  },
}

function baseOptions(over?: Partial<SpatialLayoutOptions>): SpatialLayoutOptions {
  return {
    measure: createFakeMeasure(),
    parseBody: () => ({ type: 'root', children: [] }),
    appearance: createSpatialTheme({ mode: 'light' }),
    renderContributions: [DEMO],
    ...over,
  }
}

const themed = (
  theme: string | undefined,
  nodes: SpatialCanvas['nodes'] = TWO_NODES,
): SpatialCanvas => ({
  nodes,
  edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
  ...(theme === undefined ? {} : { 'x-whiteboard': { facets: { [THEME_KEY]: { theme } } } }),
})

const TWO_NODES: SpatialCanvas['nodes'] = [
  { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 60, text: 'a' },
  { id: 'b', type: 'text', x: 300, y: 200, width: 100, height: 60, text: 'b' },
]

const shapeOf = (scene: Scene, id: string) =>
  scene.nodes.find((n): n is ShapeSceneNode => n.kind === 'shape' && n.id === id)
const edgeOf = (scene: Scene) => scene.nodes.find((n): n is ResolvedEdgeNode => n.kind === 'edge')

describe('canvas theme resolution', () => {
  it("style 'document' paints the canvas in the theme its facet names", () => {
    const scene = layoutSpatialCanvas(themed('demo.chalk'), baseOptions({ style: 'document' }))
    expect(shapeOf(scene, 'a')?.appearance?.stroke).toBe('#123456')
    expect(edgeOf(scene)?.appearance?.stroke).toBe('#abcdef')
  })

  it("style 'clean' (the library default) ignores the facet — an agent never pays unasked", () => {
    const clean = layoutSpatialCanvas(themed('demo.chalk'), baseOptions())
    const explicit = layoutSpatialCanvas(themed('demo.chalk'), baseOptions({ style: 'clean' }))
    expect(shapeOf(clean, 'a')?.appearance?.stroke).toBe('#737373')
    expect(explicit).toEqual(clean)
  })

  it('a theme id as the style is the session override: it wins over the facet and needs no facet', () => {
    const overridden = layoutSpatialCanvas(themed(undefined), baseOptions({ style: 'demo.chalk' }))
    expect(shapeOf(overridden, 'a')?.appearance?.stroke).toBe('#123456')
  })

  it('stripping the facet changes the output (the read is real, not a coincidence)', () => {
    const withTheme = layoutSpatialCanvas(themed('demo.chalk'), baseOptions({ style: 'document' }))
    const without = layoutSpatialCanvas(themed(undefined), baseOptions({ style: 'document' }))
    expect(withTheme).not.toEqual(without)
  })

  it("follows the base resolver's mode: a dark surface takes the theme's dark palette", () => {
    const scene = layoutSpatialCanvas(
      themed('demo.chalk'),
      baseOptions({ style: 'document', appearance: createSpatialTheme({ mode: 'dark' }) }),
    )
    expect(shapeOf(scene, 'a')?.appearance?.stroke).toBe('#fedcba')
  })

  it('an unknown theme id draws clean and is reported once, never thrown', () => {
    const events: SpatialLayoutDegradation[] = []
    const scene = layoutSpatialCanvas(
      themed('demo.missing'),
      baseOptions({ style: 'document', onDegrade: (e) => events.push(e) }),
    )
    expect(shapeOf(scene, 'a')?.appearance?.stroke).toBe('#737373')
    expect(events).toEqual([{ kind: 'unknown-theme', theme: 'demo.missing' }])
  })

  it('a theme asset from ANY contribution resolves by its namespaced id', () => {
    const other: RenderContribution = { namespace: 'infra', themes: { aws: CHALK } }
    const scene = layoutSpatialCanvas(
      themed('infra.aws'),
      baseOptions({ style: 'document', renderContributions: [DEMO, other] }),
    )
    expect(shapeOf(scene, 'a')?.appearance?.stroke).toBe('#123456')
  })
})

describe('theme defaults: the theme is a default, an explicit facet wins', () => {
  it('edgeRouting: the theme routes curved when the canvas says nothing', () => {
    const scene = layoutSpatialCanvas(themed('demo.chalk'), baseOptions({ style: 'document' }))
    expect(edgeOf(scene)?.rounded).toBe(true)
  })

  it('edgeRouting: an explicit visual.edges facet beats the theme default', () => {
    const canvas: SpatialCanvas = {
      ...themed('demo.chalk'),
      'x-whiteboard': {
        facets: {
          [THEME_KEY]: { theme: 'demo.chalk' },
          'visual.edges/v0': { routing: 'straight' },
        },
      },
    }
    const scene = layoutSpatialCanvas(canvas, baseOptions({ style: 'document' }))
    expect(edgeOf(scene)?.rounded).toBeUndefined()
  })

  it('nodeShape: every node without an explicit shape takes the theme default silhouette', () => {
    const scene = layoutSpatialCanvas(themed('demo.chalk'), baseOptions({ style: 'document' }))
    expect(shapeOf(scene, 'a')?.shape).toBe('demo.triangle')
  })

  it('nodeShape: a node with its own shape facet keeps it', () => {
    const nodes: SpatialCanvas['nodes'] = [
      {
        ...TWO_NODES[0]!,
        'x-whiteboard': { facets: { 'demo.shape/v0': { kind: 'square' } } },
      },
      TWO_NODES[1]!,
    ]
    const scene = layoutSpatialCanvas(
      themed('demo.chalk', nodes),
      baseOptions({ style: 'document' }),
    )
    expect(shapeOf(scene, 'a')?.shape).toBe('demo.square')
    expect(shapeOf(scene, 'b')?.shape).toBe('demo.triangle')
  })

  it('groupFrame: a group frame takes the theme dash and width', () => {
    const nodes: SpatialCanvas['nodes'] = [
      { id: 'g', type: 'group', x: 0, y: 0, width: 400, height: 300, label: 'G' },
      ...TWO_NODES,
    ]
    const scene = layoutSpatialCanvas(
      themed('demo.chalk', nodes),
      baseOptions({ style: 'document' }),
    )
    const frame = shapeOf(scene, 'g')?.appearance
    expect(frame?.stroke).toBe('#654321')
    expect(frame?.strokeDasharray).toBe('7 5')
    expect(frame?.strokeWidth).toBe(1.5)
  })
})

describe('theme fonts', () => {
  // A group's label is a label run, which is where the resolver's family lands.
  const labelled: SpatialCanvas['nodes'] = [
    { id: 'g', type: 'group', x: 0, y: 0, width: 400, height: 300, label: 'G' },
    ...TWO_NODES,
  ]
  const labelRunOf = (scene: Scene) =>
    scene.nodes.find((n): n is TextRunNode => n.kind === 'textRun')

  it('declares the theme family only when the caller says a face exists, else the bundled one, reported', () => {
    const events: SpatialLayoutDegradation[] = []
    const missing = layoutSpatialCanvas(
      themed('demo.chalk', labelled),
      baseOptions({ style: 'document', onDegrade: (e) => events.push(e) }),
    )
    expect(labelRunOf(missing)?.appearance?.fontFamily).toBe('Roboto')
    expect(events).toContainEqual({ kind: 'font-missing', family: 'Patrick Hand' })

    const present = layoutSpatialCanvas(
      themed('demo.chalk', labelled),
      baseOptions({ style: 'document', fontAvailable: () => true }),
    )
    expect(labelRunOf(present)?.appearance?.fontFamily).toBe('Patrick Hand')
  })
})

describe('embedded canvases', () => {
  const host = (): SpatialCanvas => ({
    nodes: [{ id: 'f', type: 'file', x: 0, y: 0, width: 300, height: 220, file: 'child' }],
    edges: [],
    'x-whiteboard': { facets: { [THEME_KEY]: { theme: 'demo.chalk' } } },
  })
  const child = (theme: string | undefined): SpatialCanvas => ({
    nodes: [{ id: 'c1', type: 'text', x: 0, y: 0, width: 400, height: 200, text: 'c' }],
    edges: [],
    ...(theme === undefined ? {} : { 'x-whiteboard': { facets: { [THEME_KEY]: { theme } } } }),
  })
  const PLAIN: ThemeTokens = { ...SAMPLE_THEME_TOKENS, defaults: {} }
  const contributions: RenderContribution[] = [
    DEMO,
    { namespace: 'other', themes: { plain: PLAIN } },
  ]
  const embedded = (scene: Scene) =>
    scene.nodes.find((n): n is EmbedResolvedNode => n.kind === 'embedResolved')

  it("a child without a theme inherits the host's", () => {
    const scene = layoutSpatialCanvas(
      host(),
      baseOptions({
        style: 'document',
        renderContributions: contributions,
        expandFileNode: () => true,
        resolveReference: () => ({ canvas: child(undefined) }),
      }),
    )
    const inner = embedded(scene)?.children.find(
      (n): n is ShapeSceneNode => n.kind === 'shape' && n.id === 'c1',
    )
    expect(inner?.appearance?.stroke).toBe('#123456')
  })

  it("a child naming a theme this build lacks draws clean — it does not keep the host's ink", () => {
    const events: SpatialLayoutDegradation[] = []
    const scene = layoutSpatialCanvas(
      host(),
      baseOptions({
        style: 'document',
        renderContributions: contributions,
        expandFileNode: () => true,
        resolveReference: () => ({ canvas: child('nobody.home') }),
        onDegrade: (event) => events.push(event),
      }),
    )
    const inner = embedded(scene)?.children.find(
      (n): n is ShapeSceneNode => n.kind === 'shape' && n.id === 'c1',
    )
    expect(inner?.appearance?.stroke).not.toBe('#123456')
    expect(inner?.ink).toBeUndefined()
    expect(events).toContainEqual({ kind: 'unknown-theme', theme: 'nobody.home' })
  })

  it('a child with its own theme keeps it', () => {
    const scene = layoutSpatialCanvas(
      host(),
      baseOptions({
        style: 'document',
        renderContributions: contributions,
        expandFileNode: () => true,
        resolveReference: () => ({ canvas: child('other.plain') }),
      }),
    )
    const inner = embedded(scene)?.children.find(
      (n): n is ShapeSceneNode => n.kind === 'shape' && n.id === 'c1',
    )
    expect(inner?.appearance?.stroke).toBe(SAMPLE_THEME_TOKENS.palette.light.node.text.stroke)
    expect(inner?.shape).toBeUndefined()
  })
})
