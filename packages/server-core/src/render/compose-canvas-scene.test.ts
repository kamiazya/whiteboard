import {
  assignEdgeAnchors,
  constantRatioMeasureText,
  createSpatialTheme,
  layoutSpatialCanvas,
  routeEdge,
} from '@kamiazya/whiteboard-canvas-render'
import { parseMarkdownBody } from '@kamiazya/whiteboard-codec'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { afterEach, describe, expect, test } from 'vitest'
import { setLogSink } from '../log.js'
import { composeCanvasScene } from './compose-canvas-scene.js'

afterEach(() => {
  // `sink` is module-level state in log.ts, shared across every test file
  // that imports it in the same worker — restore the no-op default so a
  // sink installed here never leaks into another file's assertions.
  setLogSink(() => {})
})

describe('composeCanvasScene', () => {
  test('a file node produces a visible chrome shape, and edges route through the shared anchor-assignment pass', () => {
    const canvas: SpatialCanvas = {
      nodes: [
        { id: 'a', type: 'file', x: 0, y: 0, width: 100, height: 60, file: 'notes/a.md' },
        { id: 'b', type: 'group', x: 300, y: 0, width: 100, height: 60 },
        { id: 'c', type: 'group', x: 300, y: 300, width: 100, height: 60 },
      ],
      edges: [
        { id: 'e1', fromNode: 'a', toNode: 'b' },
        { id: 'e2', fromNode: 'a', toNode: 'c' },
      ],
    }

    const scene = composeCanvasScene(canvas, constantRatioMeasureText)

    // (a) the file node emits a `kind: 'shape'` scene node at its own bbox.
    const fileChrome = scene.nodes.find(
      (n) =>
        n.kind === 'shape' &&
        n.bbox.x === 0 &&
        n.bbox.y === 0 &&
        n.bbox.w === 100 &&
        n.bbox.h === 60,
    )
    expect(fileChrome).toBeDefined()

    // (b) each routed edge matches routeEdge + assignEdgeAnchors run together
    // over the whole edge set — the anchor fan-out/side-optimization pass
    // that a per-edge `routeEdge` call (with no anchors) never runs. The
    // theme's edge appearance is merged on top, matching what
    // layoutSpatialCanvas's own composeEdge does.
    const style = canvas['x-whiteboard']?.edgeRouting?.style
    const anchors = assignEdgeAnchors(canvas.nodes, canvas.edges, style)
    const theme = createSpatialTheme({ mode: 'light' })
    const edgeNodes = scene.nodes.filter((n) => n.kind === 'edge')
    expect(edgeNodes).toHaveLength(2)
    for (const edge of canvas.edges) {
      const routed = routeEdge(canvas.nodes, edge, style, anchors.get(edge.id))
      const appearance = theme.resolveEdge(edge)
      const expected = appearance === undefined ? routed : { ...routed, appearance }
      const actual = edgeNodes.find((n) => n.kind === 'edge' && n.id === edge.id)
      expect(actual).toEqual(expected)
    }
  })

  test('is a pure delegate to layoutSpatialCanvas with the pinned MCP injection set (parity)', () => {
    const canvas: SpatialCanvas = {
      nodes: [
        { id: 'text', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hello **world**' },
        { id: 'file', type: 'file', x: 200, y: 0, width: 100, height: 60, file: 'a.png' },
        {
          id: 'link',
          type: 'link',
          x: 0,
          y: 200,
          width: 80,
          height: 40,
          url: 'https://example.com',
        },
        {
          id: 'group',
          type: 'group',
          x: 400,
          y: 400,
          width: 200,
          height: 200,
          label: 'a group',
        },
      ],
      edges: [
        { id: 'e1', fromNode: 'text', toNode: 'file', label: 'goes to' },
        { id: 'e2', fromNode: 'file', toNode: 'group' },
      ],
    }

    const actual = composeCanvasScene(canvas, constantRatioMeasureText)
    const expected = layoutSpatialCanvas(canvas, {
      measure: constantRatioMeasureText,
      parseBody: parseMarkdownBody,
      appearance: createSpatialTheme({ mode: 'light' }),
    })

    expect(actual).toEqual(expected)
  })

  test('HTML embedded in a text body renders as a literal rawHtml run instead of throwing', () => {
    // model's mdast subset accepts a raw `html` node verbatim (see
    // package-model.md) — parseMarkdownBody is total over any string
    // a real editor can produce, so this is not the failure path (that one
    // needs an actually-unrecognized node kind, exercised below via a node
    // with a type outside the closed union).
    const canvas: SpatialCanvas = {
      nodes: [
        {
          id: 'n1',
          type: 'text',
          x: 0,
          y: 0,
          width: 100,
          height: 50,
          text: '<div><span></div>',
        },
      ],
      edges: [],
    }

    const scene = composeCanvasScene(canvas, constantRatioMeasureText)

    const literalRun = scene.nodes.find(
      (n) => n.kind === 'rawHtml' && n.value === '<div><span></div>',
    )
    expect(literalRun).toBeDefined()
  })

  test('reports a degradation through getLogger, without changing the returned scene', () => {
    // A node `type` outside the closed union — unreachable through the
    // schema-validated store path, but canvas-render's own defensive branch
    // (spatial-canvas.ts) still degrades it to chrome-only and reports it,
    // which is what this pins.
    const canvas = {
      nodes: [{ id: 'n1', type: 'bogus', x: 0, y: 0, width: 100, height: 50 }],
      edges: [],
    } as unknown as SpatialCanvas

    const sceneWithoutSink = composeCanvasScene(canvas, constantRatioMeasureText)

    const records: unknown[] = []
    setLogSink((record) => records.push(record))
    const sceneWithSink = composeCanvasScene(canvas, constantRatioMeasureText)

    expect(records).toEqual([
      {
        scope: 'compose-canvas-scene',
        level: 'warning',
        msg: 'unrecognized spatial node kind; emitting chrome only',
        data: { nodeId: 'n1', type: 'bogus' },
      },
    ])
    // Being told is observability-only — the callback must never change
    // what was rendered.
    expect(sceneWithSink).toEqual(sceneWithoutSink)
  })

  test('is deterministic across repeated calls', () => {
    const canvas: SpatialCanvas = {
      nodes: [
        { id: 'n1', type: 'text', x: 10, y: 20, width: 100, height: 50, text: 'hello world' },
      ],
      edges: [],
    }

    expect(composeCanvasScene(canvas, constantRatioMeasureText)).toEqual(
      composeCanvasScene(canvas, constantRatioMeasureText),
    )
  })
})
