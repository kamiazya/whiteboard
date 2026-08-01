import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import type {
  HeadingBlockNode,
  Scene,
  ShapeSceneNode,
  TextRunNode,
} from '@kamiazya/whiteboard-canvas-render'
import { renderSceneToSvg } from '@kamiazya/whiteboard-canvas-render'
import { describe, expect, it, vi } from 'vitest'

import { captureLogsForTests } from '../log.js'
import { createFakeMeasure } from './spatial-scene.test-utils.js'

// Only `parseMarkdownBody('__THROW__')` is mocked to throw; every other
// input goes through the real parser. This isolates the malformed-body
// degradation test from having to find a markdown string that reliably
// falls outside canvas-codec's own versioned mdast subset — the totality
// behavior under test belongs to spatial-scene.ts, not to canvas-codec.
vi.mock('@kamiazya/whiteboard-canvas-codec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kamiazya/whiteboard-canvas-codec')>()
  return {
    ...actual,
    parseMarkdownBody: (body: string) => {
      if (body === '__THROW__') throw new Error('simulated unsupported mdast construct')
      return actual.parseMarkdownBody(body)
    },
  }
})

const { composeSpatialScene } = await import('./spatial-scene.js')
const { NODE_CORNER_RADIUS_PX, NODE_PADDING_PX } = await import('./spatial-scene-appearance.js')

const measure = createFakeMeasure()

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

describe('composeSpatialScene', () => {
  it('emits a chrome shape matching the node box plus its laid-out content', () => {
    const node = textNode()
    const scene = composeSpatialScene(canvas([node]), { measure })

    const shape = scene.nodes.find((n): n is ShapeSceneNode => n.kind === 'shape')
    expect(shape?.bbox).toEqual({ x: 100, y: 50, w: 200, h: 100 })
    // Otherwise the radius is only exercised incidentally through the SVG
    // string, which no test greps for `rx=` — dropping it would go unnoticed.
    expect(shape?.radius).toBe(NODE_CORNER_RADIUS_PX)

    const heading = scene.nodes.find((n): n is HeadingBlockNode => n.kind === 'heading')
    expect(heading).toBeDefined()
    const run = heading!.runs[0]
    expect(run.text).toBe('Title')
  })

  it('positions a laid-out block at the node coordinates plus padding', () => {
    const node = textNode({ x: 300, y: 150, text: 'plain body' })
    const scene = composeSpatialScene(canvas([node]), { measure })
    const paragraph = scene.nodes.find((n) => n.kind === 'paragraph')
    // layoutMdastBlocks places the first block's own origin at y=0, x=0 —
    // so after translation it must land exactly at node.y/x + padding.
    expect(paragraph?.bbox.y).toBe(150 + 8)
    expect(paragraph?.bbox.x).toBe(300 + 8)
  })

  it('clamps content width so it never goes negative for a narrow node', () => {
    const node = textNode({ width: 4, text: 'x' })
    const scene = composeSpatialScene(canvas([node]), { measure })
    for (const n of scene.nodes) {
      if ('bbox' in n) expect(n.bbox.w).toBeGreaterThanOrEqual(0)
    }
  })

  it('is deterministic across differently-ordered input describing the same canvas', () => {
    const a = textNode({ id: 'a', x: 0, y: 0 })
    const b = textNode({ id: 'b', x: 10, y: 0 })
    const sceneForward = composeSpatialScene(canvas([a, b]), { measure })
    const sceneReversed = composeSpatialScene(canvas([b, a]), { measure })
    expect(sceneForward).toEqual(sceneReversed)
  })

  it('breaks ties at identical position by id, independent of array order', () => {
    const a = textNode({ id: 'a', x: 5, y: 5 })
    const b = textNode({ id: 'b', x: 5, y: 5 })
    const forward = composeSpatialScene(canvas([a, b]), { measure })
    const reversed = composeSpatialScene(canvas([b, a]), { measure })
    expect(forward).toEqual(reversed)
  })

  it('routes an edge between two nodes, emitted after all node content', () => {
    const a = textNode({ id: 'a', x: 0, y: 0, width: 50, height: 50, text: 'a' })
    const b = textNode({ id: 'b', x: 200, y: 0, width: 50, height: 50, text: 'b' })
    const edge = { id: 'e1', fromNode: 'a', toNode: 'b' }
    const scene = composeSpatialScene(canvas([a, b], [edge]), { measure })

    const edgeIndex = scene.nodes.findIndex((n) => n.kind === 'edge')
    expect(edgeIndex).toBeGreaterThan(-1)
    const routedEdge = scene.nodes[edgeIndex]
    expect(routedEdge?.kind === 'edge' && routedEdge.appearance).toEqual({
      stroke: '#606060',
      strokeWidth: 1.5,
    })
    // every non-edge node must appear before the edge
    for (let i = 0; i < edgeIndex; i++) {
      expect(scene.nodes[i]?.kind).not.toBe('edge')
    }
  })

  it('degrades a missing edge endpoint instead of throwing, keeping all nodes', () => {
    const a = textNode({ id: 'a' })
    const edge = { id: 'e1', fromNode: 'a', toNode: 'ghost' }
    expect(() => composeSpatialScene(canvas([a], [edge]), { measure })).not.toThrow()
    const scene = composeSpatialScene(canvas([a], [edge]), { measure })
    expect(shapesOf(scene)).toHaveLength(1)
  })

  it('degrades an unrecognized node kind to chrome only, without throwing or dropping siblings', () => {
    const good = textNode({ id: 'good' })
    const bogus = { ...textNode({ id: 'bogus' }), type: 'bogus' } as unknown as SpatialNode
    expect(() => composeSpatialScene(canvas([good, bogus]), { measure })).not.toThrow()
    const scene = composeSpatialScene(canvas([good, bogus]), { measure })
    expect(shapesOf(scene)).toHaveLength(2)
  })

  it('degrades a malformed markdown body to a literal text run and logs a warning, leaving other nodes intact', () => {
    const capture = captureLogsForTests()
    try {
      const good = textNode({ id: 'good', text: 'fine' })
      const bad = textNode({ id: 'bad', x: 400, text: '__THROW__' })
      const scene = composeSpatialScene(canvas([good, bad]), { measure })
      expect(shapesOf(scene)).toHaveLength(2)
      const badLabel = scene.nodes.find(
        (n): n is TextRunNode => n.kind === 'textRun' && n.text === '__THROW__',
      )
      expect(badLabel).toBeDefined()
      // The fallback run must land inside its own node box. Asserting only
      // its text would miss an offset applied twice, which puts the literal
      // text a full node-origin away from the box it belongs to.
      expect(badLabel?.bbox.x).toBe(400 + NODE_PADDING_PX)
      expect(capture.records.some((r) => r.level === 'warning')).toBe(true)
    } finally {
      capture.restore()
    }
  })

  it('composes a zero-size node without throwing, emitting a zero-area shape', () => {
    const node = textNode({ width: 0, height: 0 })
    expect(() => composeSpatialScene(canvas([node]), { measure })).not.toThrow()
    const scene = composeSpatialScene(canvas([node]), { measure })
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
    const scene = composeSpatialScene(canvas([node]), { measure })
    const label = scene.nodes.find((n): n is TextRunNode => n.kind === 'textRun')
    expect(label?.text).toBe('notes/a.md#heading')
    // Locks the other side of the placement invariant: a label run is
    // content-origin-relative and is placed by its caller, exactly like
    // layoutMdastBlocks output. Both paths must agree or one of them drifts.
    expect(label?.bbox.x).toBe(node.x + NODE_PADDING_PX)
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
    const scene = composeSpatialScene(canvas([node]), { measure })
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
    const scene = composeSpatialScene(canvas([labeled]), { measure })
    const label = scene.nodes.find((n): n is TextRunNode => n.kind === 'textRun')
    expect(label?.text).toBe('Section A')

    const unlabeled: Extract<SpatialNode, { type: 'group' }> = {
      ...labeled,
      id: 'g2',
      label: undefined,
    }
    const sceneNoLabel = composeSpatialScene(canvas([unlabeled]), { measure })
    expect(sceneNoLabel.nodes.every((n) => n.kind !== 'textRun')).toBe(true)
  })

  it('gives every group chrome a "none" fill so it can never occlude a sibling', () => {
    const node: Extract<SpatialNode, { type: 'group' }> = {
      id: 'g1',
      type: 'group',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    }
    const scene = composeSpatialScene(canvas([node]), { measure })
    const shape = shapesOf(scene)[0]
    expect(shape?.appearance?.fill).toBe('none')
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
    const scene = composeSpatialScene(canvas([a, b]), { measure })
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
})
