import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it, vi } from 'vitest'
import type { HeadingBlockNode, Scene, ShapeSceneNode, TextRunNode } from '../scene-graph.js'
import { renderSceneToSvg } from '../svg/backend.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import type { SpatialAppearanceResolver } from './spatial-appearance.js'
import type { SpatialLayoutDegradation, SpatialLayoutOptions } from './spatial-canvas.js'
import { layoutSpatialCanvas, layoutSpatialEdges } from './spatial-canvas.js'

const NODE_PADDING_PX = 8
const NODE_CORNER_RADIUS_PX = 4
const LABEL_FONT_SIZE_PX = 14
const MIN_CONTENT_WIDTH_PX = 1

const measure = createFakeMeasure()

/** Mirrors the export composition root's fixed per-node-kind chrome. */
const fakeAppearance: SpatialAppearanceResolver = {
  resolveNode: () => ({ radius: NODE_CORNER_RADIUS_PX }),
  resolveEdge: () => ({ stroke: '#606060', strokeWidth: 1.5 }),
  resolveLabel: () => ({ fill: '#303030', fontFamily: 'sans-serif' }),
}

const fakeGeometry = {
  paddingPx: NODE_PADDING_PX,
  labelFontSizePx: LABEL_FONT_SIZE_PX,
  minContentWidthPx: MIN_CONTENT_WIDTH_PX,
}

function baseOptions(overrides: Partial<SpatialLayoutOptions> = {}): SpatialLayoutOptions {
  return {
    measure,
    parseBody: fakeParseBody,
    appearance: fakeAppearance,
    geometry: fakeGeometry,
    ...overrides,
  }
}

// A tiny fake mdast parser: '#'-prefixed text becomes a heading, everything
// else becomes a single paragraph — enough to exercise layoutMdastBlocks
// without depending on codec (a cross-package dependency this
// package must not take). `__THROW__` simulates a construct outside the
// caller's accepted subset.
function fakeParseBody(text: string): MdastRoot {
  if (text === '__THROW__') throw new Error('simulated unsupported mdast construct')
  if (text.startsWith('# ')) {
    return {
      type: 'root',
      children: [
        {
          type: 'heading',
          depth: 1,
          children: [{ type: 'text', value: text.slice(2) }],
        },
      ],
    }
  }
  return {
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
  }
}

function textNode(
  overrides: Partial<Extract<SpatialNode, { type: 'text' }>> = {},
): Extract<SpatialNode, { type: 'text' }> {
  return {
    id: 'n1',
    type: 'text',
    x: 100,
    y: 50,
    width: 200,
    height: 100,
    text: '# Title',
    ...overrides,
  }
}

function canvas(nodes: SpatialNode[], edges: SpatialCanvas['edges'] = []): SpatialCanvas {
  return { nodes, edges }
}

function shapesOf(scene: Scene): ShapeSceneNode[] {
  return scene.nodes.filter((n): n is ShapeSceneNode => n.kind === 'shape')
}

describe('layoutSpatialCanvas', () => {
  it('emits a chrome shape matching the node box plus its laid-out content', () => {
    const node = textNode()
    const scene = layoutSpatialCanvas(canvas([node]), baseOptions())

    const shape = scene.nodes.find((n): n is ShapeSceneNode => n.kind === 'shape')
    expect(shape?.bbox).toEqual({ x: 100, y: 50, w: 200, h: 100 })
    expect(shape?.radius).toBe(NODE_CORNER_RADIUS_PX)

    const heading = scene.nodes.find((n): n is HeadingBlockNode => n.kind === 'heading')
    expect(heading).toBeDefined()
    const run = heading!.runs[0]
    expect(run.text).toBe('Title')
  })

  it('positions a laid-out block at the node coordinates plus padding', () => {
    const node = textNode({ x: 300, y: 150, text: 'plain body' })
    const scene = layoutSpatialCanvas(canvas([node]), baseOptions())
    const paragraph = scene.nodes.find((n) => n.kind === 'paragraph')
    expect(paragraph?.bbox.y).toBe(150 + NODE_PADDING_PX)
    expect(paragraph?.bbox.x).toBe(300 + NODE_PADDING_PX)
  })

  it('clamps content width so it never goes negative for a narrow node', () => {
    const node = textNode({ width: 4, text: 'x' })
    const scene = layoutSpatialCanvas(canvas([node]), baseOptions())
    for (const n of scene.nodes) {
      if ('bbox' in n) expect(n.bbox.w).toBeGreaterThanOrEqual(0)
    }
  })

  it('preserves document order: each node in array order, shape then content, then all edges', () => {
    const a = textNode({ id: 'a', x: 0, y: 0, text: 'a' })
    const b = textNode({ id: 'b', x: 10, y: 0, text: 'b' })
    const edge = { id: 'e1', fromNode: 'a', toNode: 'b' }
    const options = baseOptions()

    const forward = layoutSpatialCanvas(canvas([a, b], [edge]), options)
    const reversed = layoutSpatialCanvas(canvas([b, a], [edge]), options)
    // Reordering the authored node array changes emitted (z-)order — z-order
    // is document order, deliberately not sorted by position.
    expect(forward).not.toEqual(reversed)

    const edgeIndex = forward.nodes.findIndex((n) => n.kind === 'edge')
    expect(edgeIndex).toBe(forward.nodes.length - 1)
  })

  it('routes an edge between two nodes, emitted after all node content', () => {
    const a = textNode({ id: 'a', x: 0, y: 0, width: 50, height: 50, text: 'a' })
    const b = textNode({ id: 'b', x: 200, y: 0, width: 50, height: 50, text: 'b' })
    const edge = { id: 'e1', fromNode: 'a', toNode: 'b' }
    const scene = layoutSpatialCanvas(canvas([a, b], [edge]), baseOptions())

    const edgeIndex = scene.nodes.findIndex((n) => n.kind === 'edge')
    expect(edgeIndex).toBeGreaterThan(-1)
    const routedEdge = scene.nodes[edgeIndex]
    expect(routedEdge?.kind === 'edge' && routedEdge.appearance).toEqual({
      stroke: '#606060',
      strokeWidth: 1.5,
    })
    for (let i = 0; i < edgeIndex; i++) {
      expect(scene.nodes[i]?.kind).not.toBe('edge')
    }
  })

  it('emits a label run for an edge that carries one, centered on the routed path midpoint', () => {
    const a = textNode({ id: 'a', x: 0, y: 0, width: 50, height: 50, text: 'a' })
    const b = textNode({ id: 'b', x: 200, y: 0, width: 50, height: 50, text: 'b' })
    const edge = { id: 'e1', fromNode: 'a', toNode: 'b', label: 'edge label' }
    const scene = layoutSpatialCanvas(canvas([a, b], [edge]), baseOptions())

    const label = scene.nodes.find(
      (n): n is TextRunNode => n.kind === 'textRun' && n.text === 'edge label',
    )
    expect(label).toBeDefined()
    expect(label?.appearance?.fill).toBe('#303030')
  })

  it('centers a multi-segment edge label at the arc-length midpoint, not a corner vertex', () => {
    // Diagonal neighbours route as an L with unequal legs; the label must
    // sit halfway along the DRAWN line (the same anchor the editor's
    // inline label editor uses), not on the index-middle waypoint, which
    // for an L-route is the corner itself.
    const a = textNode({ id: 'a', x: 0, y: 0, width: 50, height: 50, text: 'a' })
    const b = textNode({ id: 'b', x: 300, y: 200, width: 50, height: 50, text: 'b' })
    const edge = { id: 'e1', fromNode: 'a', toNode: 'b', label: 'L' }
    const scene = layoutSpatialCanvas(
      { ...canvas([a, b], [edge]), 'x-whiteboard': { edgeRouting: { style: 'orthogonal' } } },
      baseOptions(),
    )
    const routed = scene.nodes.find(
      (n): n is import('../scene-graph.js').ResolvedEdgeNode => n.kind === 'edge',
    )
    const label = scene.nodes.find((n): n is TextRunNode => n.kind === 'textRun' && n.text === 'L')
    expect(routed).toBeDefined()
    expect(label).toBeDefined()
    if (routed === undefined || label === undefined) return
    // Independent arc-length midpoint of the routed path.
    let total = 0
    const lengths = routed.path.slice(1).map((p, i) => {
      const l = Math.hypot(p.x - routed.path[i]!.x, p.y - routed.path[i]!.y)
      total += l
      return l
    })
    let remaining = total / 2
    let expected = routed.path[0]!
    for (let i = 0; i < lengths.length; i++) {
      if (remaining <= lengths[i]!) {
        const t = lengths[i] === 0 ? 0 : remaining / lengths[i]!
        const from = routed.path[i]!
        const to = routed.path[i + 1]!
        expected = { x: from.x + t * (to.x - from.x), y: from.y + t * (to.y - from.y) }
        break
      }
      remaining -= lengths[i]!
    }
    expect(label.bbox.x + label.bbox.w / 2).toBeCloseTo(expected.x, 6)
    expect(label.bbox.y + label.bbox.h / 2).toBeCloseTo(expected.y, 6)
  })

  it('emits no label run for an edge with no label', () => {
    const a = textNode({ id: 'a', x: 0, y: 0, width: 50, height: 50, text: 'a' })
    const b = textNode({ id: 'b', x: 200, y: 0, width: 50, height: 50, text: 'b' })
    const edge = { id: 'e1', fromNode: 'a', toNode: 'b' }
    const scene = layoutSpatialCanvas(canvas([a, b], [edge]), baseOptions())
    expect(scene.nodes.some((n) => n.kind === 'textRun' && n.text === 'edge label')).toBe(false)
  })

  it('emits no label run for an edge with an empty-string label', () => {
    const a = textNode({ id: 'a', x: 0, y: 0, width: 50, height: 50, text: 'a' })
    const b = textNode({ id: 'b', x: 200, y: 0, width: 50, height: 50, text: 'b' })
    const edge = { id: 'e1', fromNode: 'a', toNode: 'b', label: '' }
    const scene = layoutSpatialCanvas(canvas([a, b], [edge]), baseOptions())
    expect(scene.nodes.some((n) => n.kind === 'textRun' && n.bbox.w === 0)).toBe(false)
  })

  it('drops the label of an edge whose endpoint is missing, rather than floating it', () => {
    const a = textNode({ id: 'a' })
    const edge = { id: 'e1', fromNode: 'a', toNode: 'ghost', label: 'edge label' }
    let scene!: ReturnType<typeof layoutSpatialCanvas>
    expect(() => {
      scene = layoutSpatialCanvas(canvas([a], [edge]), baseOptions())
    }).not.toThrow()
    // Not-throwing alone would still pass with the label drawn on the
    // unrouted edge's lone fallback point — text with no line attached.
    expect(scene.nodes.some((n) => n.kind === 'textRun' && n.text === 'edge label')).toBe(false)
  })

  it('degrades a missing edge endpoint instead of throwing, keeping all nodes', () => {
    const a = textNode({ id: 'a' })
    const edge = { id: 'e1', fromNode: 'a', toNode: 'ghost' }
    // A throw here fails the test — the assertion below is on the degraded result.
    const scene = layoutSpatialCanvas(canvas([a], [edge]), baseOptions())
    expect(shapesOf(scene)).toHaveLength(1)
  })

  it('degrades an unrecognized node kind to chrome only, without throwing or dropping siblings', () => {
    const good = textNode({ id: 'good' })
    const bogus = { ...textNode({ id: 'bogus' }), type: 'bogus' } as unknown as SpatialNode
    const scene = layoutSpatialCanvas(canvas([good, bogus]), baseOptions())
    expect(shapesOf(scene)).toHaveLength(2)
  })

  it('reports an unrecognized node kind via onDegrade when supplied', () => {
    const bogus = { ...textNode({ id: 'bogus' }), type: 'bogus' } as unknown as SpatialNode
    const onDegrade = vi.fn<(event: SpatialLayoutDegradation) => void>()
    layoutSpatialCanvas(canvas([bogus]), baseOptions({ onDegrade }))
    expect(onDegrade).toHaveBeenCalledWith({
      kind: 'unknown-node-kind',
      nodeId: 'bogus',
      type: 'bogus',
    })
  })

  it('degrades a malformed markdown body to a literal text run, leaving other nodes intact', () => {
    const good = textNode({ id: 'good', text: 'fine' })
    const bad = textNode({ id: 'bad', x: 400, text: '__THROW__' })
    const scene = layoutSpatialCanvas(canvas([good, bad]), baseOptions())
    expect(shapesOf(scene)).toHaveLength(2)
    const badLabel = scene.nodes.find(
      (n): n is TextRunNode => n.kind === 'textRun' && n.text === '__THROW__',
    )
    expect(badLabel).toBeDefined()
    // The fallback run must land inside its own node box — asserting only
    // its text would miss an offset applied twice.
    expect(badLabel?.bbox.x).toBe(400 + NODE_PADDING_PX)
  })

  it('reports a body-parse failure via onDegrade when supplied', () => {
    const bad = textNode({ id: 'bad', text: '__THROW__' })
    const onDegrade = vi.fn<(event: SpatialLayoutDegradation) => void>()
    layoutSpatialCanvas(canvas([bad]), baseOptions({ onDegrade }))
    expect(onDegrade).toHaveBeenCalledTimes(1)
    const [event] = onDegrade.mock.calls[0]!
    expect(event.kind).toBe('body-parse-failed')
    expect((event as { nodeId: string }).nodeId).toBe('bad')
  })

  it('degrades silently (no throw) when onDegrade is omitted', () => {
    const bad = textNode({ id: 'bad', text: '__THROW__' })
    expect(() => layoutSpatialCanvas(canvas([bad]), baseOptions())).not.toThrow()
  })

  it('composes a zero-size node without throwing, emitting a zero-area shape', () => {
    const node = textNode({ width: 0, height: 0 })
    const scene = layoutSpatialCanvas(canvas([node]), baseOptions())
    const shape = shapesOf(scene)[0]
    expect(shape?.bbox.w).toBe(0)
    expect(shape?.bbox.h).toBe(0)
  })

  it('renders a file node as chrome plus a label containing the path and subpath', () => {
    const node: Extract<SpatialNode, { type: 'file' }> = {
      id: 'f1',
      type: 'file',
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      file: 'notes/a.md',
      subpath: '#heading',
    }
    const scene = layoutSpatialCanvas(canvas([node]), baseOptions())
    const label = scene.nodes.find((n): n is TextRunNode => n.kind === 'textRun')
    expect(label?.text).toBe('notes/a.md#heading')
    expect(label?.bbox.x).toBe(node.x + NODE_PADDING_PX)
  })

  it('a resolved label replaces a file node label; failures fall back to the raw reference', () => {
    const node: Extract<SpatialNode, { type: 'file' }> = {
      id: 'f1',
      type: 'file',
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      file: 'opaque-id-123',
    }
    const resolved = layoutSpatialCanvas(canvas([node]), {
      ...baseOptions(),
      resolveReference: (ref) => (ref === 'opaque-id-123' ? { label: 'Release plan' } : undefined),
    })
    const label = resolved.nodes.find((n): n is TextRunNode => n.kind === 'textRun')
    expect(label?.text).toBe('Release plan')

    // Unknown reference -> undefined -> the raw string still shows, and a
    // throwing resolver degrades the same way instead of aborting layout.
    const unknown = layoutSpatialCanvas(canvas([node]), {
      ...baseOptions(),
      resolveReference: () => undefined,
    })
    expect(unknown.nodes.find((n): n is TextRunNode => n.kind === 'textRun')?.text).toBe(
      'opaque-id-123',
    )
    const throwing = layoutSpatialCanvas(canvas([node]), {
      ...baseOptions(),
      resolveReference: () => {
        throw new Error('boom')
      },
    })
    expect(throwing.nodes.find((n): n is TextRunNode => n.kind === 'textRun')?.text).toBe(
      'opaque-id-123',
    )
  })

  it('a reference resolved as missing renders a quiet label instead of the raw reference', () => {
    const node: Extract<SpatialNode, { type: 'file' }> = {
      id: 'f1',
      type: 'file',
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      file: 'dangling-id-123',
      subpath: '#heading',
    }
    const missing = layoutSpatialCanvas(canvas([node]), {
      ...baseOptions(),
      resolveReference: (ref) => ({ missing: ref === 'dangling-id-123' }),
    })
    // The raw reference is an opaque id — useless to a reader — and the
    // subpath is moot without a target, so neither appears.
    expect(missing.nodes.find((n): n is TextRunNode => n.kind === 'textRun')?.text).toBe(
      'Missing reference',
    )

    // Not missing -> the ordinary label path (raw ref + subpath) is untouched.
    const present = layoutSpatialCanvas(canvas([node]), {
      ...baseOptions(),
      resolveReference: () => ({ missing: false }),
    })
    expect(present.nodes.find((n): n is TextRunNode => n.kind === 'textRun')?.text).toBe(
      'dangling-id-123#heading',
    )

    // A throwing callback degrades to not-missing (total-layout rule).
    const throwing = layoutSpatialCanvas(canvas([node]), {
      ...baseOptions(),
      resolveReference: () => {
        throw new Error('boom')
      },
    })
    expect(throwing.nodes.find((n): n is TextRunNode => n.kind === 'textRun')?.text).toBe(
      'dangling-id-123#heading',
    )
  })

  it('renders a link node as chrome plus a label containing the url', () => {
    const node: Extract<SpatialNode, { type: 'link' }> = {
      id: 'l1',
      type: 'link',
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      url: 'https://example.com/page',
    }
    const scene = layoutSpatialCanvas(canvas([node]), baseOptions())
    const label = scene.nodes.find((n): n is TextRunNode => n.kind === 'textRun')
    expect(label?.text).toBe('https://example.com/page')
  })

  it('renders a group node as chrome plus its label, and chrome-only when unlabeled', () => {
    const labeled: Extract<SpatialNode, { type: 'group' }> = {
      id: 'g1',
      type: 'group',
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      label: 'Section A',
    }
    const scene = layoutSpatialCanvas(canvas([labeled]), baseOptions())
    const label = scene.nodes.find((n): n is TextRunNode => n.kind === 'textRun')
    expect(label?.text).toBe('Section A')
    // Container labels sit OUTSIDE the frame, above its top edge (the
    // jsoncanvas.org convention) — that is what visually distinguishes a
    // container from a regular node.
    expect(label !== undefined && label.bbox.y + label.bbox.h <= labeled.y).toBe(true)
    expect(label?.bbox.x).toBe(labeled.x)

    const unlabeled: Extract<SpatialNode, { type: 'group' }> = {
      ...labeled,
      id: 'g2',
      label: undefined,
    }
    const sceneNoLabel = layoutSpatialCanvas(canvas([unlabeled]), baseOptions())
    expect(sceneNoLabel.nodes.every((n) => n.kind !== 'textRun')).toBe(true)
  })

  it('renders an empty canvas as an empty scene without throwing', () => {
    expect(layoutSpatialCanvas(canvas([]), baseOptions())).toEqual({ nodes: [] })
  })

  it('renders a text node with empty text without throwing', () => {
    const node = textNode({ text: '' })
    const options = baseOptions()
    expect(() => layoutSpatialCanvas(canvas([node]), options)).not.toThrow()
  })

  it('renders the composed scene through renderSceneToSvg with a viewBox containing all content', () => {
    const a = textNode({ id: 'a', x: 10, y: 20, width: 120, height: 60, text: 'hello' })
    const b: Extract<SpatialNode, { type: 'file' }> = {
      id: 'b',
      type: 'file',
      x: 400,
      y: 300,
      width: 100,
      height: 50,
      file: 'x.md',
    }
    const scene = layoutSpatialCanvas(canvas([a, b]), baseOptions())
    const svg = renderSceneToSvg(scene, { padding: 16 })

    const match = svg.match(/viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/)
    expect(match).not.toBeNull()
    const [, vx, vy, vw, vh] = match!.map(Number)

    for (const node of shapesOf(scene)) {
      expect(node.bbox.x).toBeGreaterThanOrEqual(vx!)
      expect(node.bbox.y).toBeGreaterThanOrEqual(vy!)
      expect(node.bbox.x + node.bbox.w).toBeLessThanOrEqual(vx! + vw!)
      expect(node.bbox.y + node.bbox.h).toBeLessThanOrEqual(vy! + vh!)
    }
  })

  it('composing the same canvas twice yields byte-identical SVG (determinism)', () => {
    const a = textNode({ id: 'a', text: 'hello' })
    const options = baseOptions()
    const svgA = renderSceneToSvg(layoutSpatialCanvas(canvas([a]), options), { padding: 4 })
    const svgB = renderSceneToSvg(layoutSpatialCanvas(canvas([a]), options), { padding: 4 })
    expect(svgA).toBe(svgB)
  })

  it('appearance-independent geometry: two resolvers with identical geometry constants but different colors produce identical bboxes', () => {
    const colorfulResolver: SpatialAppearanceResolver = {
      ...fakeAppearance,
      resolveNode: () => ({ radius: NODE_CORNER_RADIUS_PX, appearance: { fill: '#ff0000' } }),
      resolveEdge: () => ({ stroke: '#00ff00' }),
    }
    const a = textNode({ id: 'a', text: 'hello world' })
    const b = textNode({ id: 'b', x: 500, text: 'file' })
    const edge = { id: 'e1', fromNode: 'a', toNode: 'b' }
    const options1 = baseOptions({ appearance: fakeAppearance })
    const options2 = baseOptions({ appearance: colorfulResolver })
    const scene1 = layoutSpatialCanvas(canvas([a, b], [edge]), options1)
    const scene2 = layoutSpatialCanvas(canvas([a, b], [edge]), options2)

    const stripAppearance = (scene: Scene) =>
      scene.nodes.map((n) => {
        const {
          appearance: _appearance,
          radius: _radius,
          ...rest
        } = n as unknown as Record<string, unknown>
        return rest
      })
    expect(stripAppearance(scene1)).toEqual(stripAppearance(scene2))
  })

  it('falls back to the shared default geometry field-by-field when an override is degenerate', () => {
    const a = textNode({ id: 'a', text: 'hello world' })
    const b = textNode({ id: 'b', x: 500, text: 'file' })
    const edge = { id: 'e1', fromNode: 'a', toNode: 'b', label: 'link' }
    const built = canvas([a, b], [edge])

    // Omitting `geometry` entirely resolves to the shared
    // `SPATIAL_THEME_GEOMETRY` default — the same target a fully degenerate
    // override must fall back to, field-by-field.
    const baseline = layoutSpatialCanvas(built, baseOptions({ geometry: undefined }))
    const degenerate = layoutSpatialCanvas(
      built,
      baseOptions({
        // NaN paddingPx, zero labelFontSizePx (must be > 0), negative
        // minContentWidthPx — every field individually degenerate.
        geometry: { paddingPx: Number.NaN, labelFontSizePx: 0, minContentWidthPx: -10 },
      }),
    )

    expect(degenerate).toEqual(baseline)
  })
})

// The routing style rides on the canvas this function already receives, so
// honouring it needs no plumbing through the editor, export or viewer. These
// pin that it is READ — a router supporting a style nothing passes to it is
// not a feature.
describe('edge routing style from the canvas', () => {
  const twoNodes = [textNode({ id: 'a', x: 0, y: 0 }), textNode({ id: 'b', x: 400, y: 200 })]
  const link: SpatialCanvas['edges'] = [{ id: 'e1', fromNode: 'a', toNode: 'b' }]

  const edgePathOf = (canvasValue: SpatialCanvas) => {
    const scene = layoutSpatialCanvas(canvasValue, baseOptions())
    const found = scene.nodes.find((n) => n.kind === 'edge')
    if (found === undefined || found.kind !== 'edge') throw new Error('no edge in scene')
    return found.path
  }

  it('bends the edge when the canvas asks for orthogonal', () => {
    const path = edgePathOf({
      ...canvas(twoNodes, link),
      'x-whiteboard': { edgeRouting: { style: 'orthogonal' } },
    })
    expect(path.length).toBeGreaterThan(2)
  })

  it('leaves it direct when the canvas says nothing', () => {
    expect(edgePathOf(canvas(twoNodes, link))).toHaveLength(2)
  })
})

describe('group background images (JSON Canvas group.background/backgroundStyle)', () => {
  const groupWithBackground = (backgroundStyle?: 'cover' | 'ratio' | 'repeat'): SpatialCanvas => ({
    nodes: [
      {
        id: 'g1',
        type: 'group',
        x: 40,
        y: 60,
        width: 400,
        height: 300,
        background: 'bg.png',
        ...(backgroundStyle !== undefined ? { backgroundStyle } : {}),
      },
    ],
    edges: [],
  })
  const withImage = (overrides: Partial<SpatialLayoutOptions> = {}) =>
    baseOptions({ resolveReference: (ref) => ({ image: { href: `app://${ref}` } }), ...overrides })

  it('renders the background as a full-frame image between chrome and label', () => {
    const scene = layoutSpatialCanvas(groupWithBackground(), withImage())
    const image = scene.nodes.find((n) => n.kind === 'image')
    expect(image).toMatchObject({
      kind: 'image',
      bbox: { x: 40, y: 60, w: 400, h: 300 },
      href: 'app://bg.png',
      fit: 'cover',
    })
    // Painted after the frame chrome so the stroke stays visible? No — the
    // image sits INSIDE the frame: chrome first, image second.
    const kinds = scene.nodes.map((n) => n.kind)
    expect(kinds.indexOf('shape')).toBeLessThan(kinds.indexOf('image'))
  })

  it("maps backgroundStyle 'ratio' to contain and default/'cover' to cover", () => {
    const ratio = layoutSpatialCanvas(groupWithBackground('ratio'), withImage())
    expect(ratio.nodes.find((n) => n.kind === 'image')).toMatchObject({ fit: 'contain' })
    const cover = layoutSpatialCanvas(groupWithBackground('cover'), withImage())
    expect(cover.nodes.find((n) => n.kind === 'image')).toMatchObject({ fit: 'cover' })
  })

  it("degrades backgroundStyle 'repeat' to cover and reports it", () => {
    const onDegrade = vi.fn()
    const scene = layoutSpatialCanvas(groupWithBackground('repeat'), withImage({ onDegrade }))
    expect(scene.nodes.find((n) => n.kind === 'image')).toMatchObject({ fit: 'cover' })
    expect(onDegrade).toHaveBeenCalledWith({
      kind: 'unsupported-background-style',
      nodeId: 'g1',
      style: 'repeat',
    })
  })

  it('keeps the plain frame when no resolver is supplied or resolution fails', () => {
    expect(
      layoutSpatialCanvas(groupWithBackground(), baseOptions()).nodes.some(
        (n) => n.kind === 'image',
      ),
    ).toBe(false)
    const throwing = baseOptions({
      resolveReference: () => {
        throw new Error('no store')
      },
    })
    expect(
      layoutSpatialCanvas(groupWithBackground(), throwing).nodes.some((n) => n.kind === 'image'),
    ).toBe(false)
  })
})

describe('layoutSpatialEdges', () => {
  // One producer per geometry: the standalone edge layout must equal the
  // edge-and-label suffix of the full scene, or a live-preview consumer
  // drifts from the committed render.
  it('equals the edge+label suffix of the full layout, jumps and labels included', () => {
    const canvas: SpatialCanvas = {
      nodes: [
        { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 40, text: 'a' },
        { id: 'b', type: 'text', x: 300, y: 0, width: 100, height: 40, text: 'b' },
        { id: 'c', type: 'text', x: 150, y: -200, width: 100, height: 40, text: 'c' },
        { id: 'd', type: 'text', x: 150, y: 200, width: 100, height: 40, text: 'd' },
      ],
      edges: [
        { id: 'e1', fromNode: 'a', toNode: 'b', label: 'across' },
        { id: 'e2', fromNode: 'c', toNode: 'd' },
      ],
      'x-whiteboard': { edgeRouting: { lineJumps: 'arc' } },
    }
    const options = baseOptions()
    const full = layoutSpatialCanvas(canvas, options).nodes
    const edgesOnly = layoutSpatialEdges(canvas, options)
    expect(edgesOnly.length).toBeGreaterThan(0)
    expect(edgesOnly).toEqual(full.slice(full.length - edgesOnly.length))
  })
})
