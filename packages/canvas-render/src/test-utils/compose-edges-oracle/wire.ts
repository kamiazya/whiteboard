import type {
  CanvasEdge,
  CanvasLine,
  EdgeEnd,
  LineEnd,
  SpatialCanvas,
  SpatialNode,
} from '@kamiazya/whiteboard-model'
import type { RoutableElement } from '@kamiazya/whiteboard-scene'
import type { Board } from './corpus.js'

/**
 * A board as the Rust replay reads it: every double as the hex of its bits, an
 * element's facets left out (the replay is handed what the readers answer,
 * `Facts`), and the silhouettes and frozen sides beside the canvas.
 */

type Hex = (value: number) => string

interface NodeWire {
  readonly id: string
  readonly box: readonly string[]
  readonly resource?: SpatialNode['resource']
  readonly label?: string
}

interface EndWire {
  readonly node?: string
  readonly point?: readonly string[]
  readonly side?: string
  readonly end?: string
}

interface ElementWire {
  readonly id: string
  readonly from: EndWire
  readonly to: EndWire
  readonly label?: string
  readonly color?: string
  readonly bends?: readonly (readonly string[])[]
}

interface OverrideWire {
  readonly fromSide: string
  readonly toSide: string
  readonly around?: boolean
  readonly from?: readonly string[]
  readonly to?: readonly string[]
  readonly fromLaneDepth?: string
  readonly toLaneDepth?: string
}

export interface Wire {
  readonly nodes: readonly NodeWire[]
  readonly edges: readonly ElementWire[]
  readonly lines?: readonly ElementWire[]
  readonly shapes: Readonly<Record<string, string>>
  readonly overrides?: readonly (readonly [string, OverrideWire])[]
}

/** What the plugin's facet readers answer: the canvas's `visual.edges`, each element's own, and its weight. */
export interface Facts {
  readonly canvas: { readonly style?: string; readonly lineJumps?: string }
  /** One per element, edges then lines, as `resolveEdgeOwnStyle` answers it. */
  readonly own: readonly { readonly routing?: string; readonly lineJumps?: string }[]
  /** One per element, edges then lines, as `resolveStrokeWidth` answers it. */
  readonly stroke: readonly string[]
}

const nodeWire = (node: SpatialNode, hex: Hex): NodeWire => ({
  id: node.id,
  box: [node.x, node.y, node.width, node.height].map(hex),
  ...(node.resource === undefined ? {} : { resource: node.resource }),
  ...(node.label === undefined ? {} : { label: node.label }),
})

function endWire(end: EdgeEnd | LineEnd, hex: Hex): EndWire {
  const marks = {
    ...('side' in end && end.side !== undefined ? { side: end.side } : {}),
    ...(end.end === undefined ? {} : { end: end.end }),
  }
  if ('kind' in end && end.kind === 'point') {
    return { point: [hex(end.point.x), hex(end.point.y)], ...marks }
  }
  return { node: end.node, ...marks }
}

const elementWire = (element: CanvasEdge | CanvasLine, hex: Hex): ElementWire => ({
  id: element.id,
  from: endWire(element.from, hex),
  to: endWire(element.to, hex),
  ...(element.label === undefined ? {} : { label: element.label }),
  ...(element.color === undefined ? {} : { color: element.color }),
  ...(element.bends === undefined ? {} : { bends: element.bends.map((b) => [hex(b.x), hex(b.y)]) }),
})

export function canvasWire(board: Board, hex: Hex): Omit<Wire, 'overrides'> {
  const { canvas } = board
  return {
    nodes: canvas.nodes.map((node) => nodeWire(node, hex)),
    edges: canvas.edges.map((edge) => elementWire(edge, hex)),
    ...(canvas.lines === undefined ? {} : { lines: canvas.lines.map((l) => elementWire(l, hex)) }),
    shapes: board.shapes,
  }
}

export function overridesWire(board: Board, hex: Hex): Pick<Wire, 'overrides'> {
  if (board.overrides === undefined) return {}
  const point = (p: { x: number; y: number } | undefined) =>
    p === undefined ? {} : { point: [hex(p.x), hex(p.y)] }
  const overrides = board.overrides.map(([id, o]) => {
    const wire: OverrideWire = {
      fromSide: o.fromSide,
      toSide: o.toSide,
      ...(o.around === undefined ? {} : { around: o.around }),
      ...(o.from === undefined ? {} : { from: point(o.from).point }),
      ...(o.to === undefined ? {} : { to: point(o.to).point }),
      ...(o.fromLaneDepth === undefined ? {} : { fromLaneDepth: hex(o.fromLaneDepth) }),
      ...(o.toLaneDepth === undefined ? {} : { toLaneDepth: hex(o.toLaneDepth) }),
    }
    return [id, wire] as const
  })
  return { overrides }
}

export function factsOf(
  canvas: SpatialCanvas,
  canvasStyle: (canvas: SpatialCanvas) => { style?: string; lineJumps?: string },
  ownStyle: (element: RoutableElement) => { routing?: string; lineJumps?: string },
  strokeWidth: (element: RoutableElement) => string,
): Facts {
  const routable: RoutableElement[] = [...canvas.edges, ...(canvas.lines ?? [])]
  return {
    canvas: canvasStyle(canvas),
    own: routable.map((element) => ownStyle(element)),
    stroke: routable.map((element) => strokeWidth(element)),
  }
}
