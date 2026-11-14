import type {
  CanvasEdge,
  CanvasLine,
  EdgeEnd,
  LineEnd,
  SpatialCanvas,
  SpatialNode,
} from '@kamiazya/whiteboard-model'

/**
 * A canvas as the Rust replay reads it: every double as the hex of its bits,
 * everything else as the canvas holds it.
 */

type Hex = (value: number) => string

interface NodeWire extends Omit<SpatialNode, 'x' | 'y' | 'width' | 'height'> {
  readonly box: readonly string[]
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
  readonly facets?: CanvasEdge['facets']
  readonly tags?: readonly string[]
}

export interface CanvasWire {
  readonly facets?: SpatialCanvas['facets']
  readonly tags?: readonly string[]
  readonly nodes: readonly NodeWire[]
  readonly edges: readonly ElementWire[]
  readonly lines?: readonly ElementWire[]
}

function nodeWire(node: SpatialNode, hex: Hex): NodeWire {
  const { x, y, width, height, ...rest } = node
  return { ...rest, box: [x, y, width, height].map(hex) }
}

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

function elementWire(element: CanvasEdge | CanvasLine, hex: Hex): ElementWire {
  const { from, to, bends, ...rest } = element
  return {
    ...rest,
    from: endWire(from, hex),
    to: endWire(to, hex),
    ...(bends === undefined ? {} : { bends: bends.map((b) => [hex(b.x), hex(b.y)]) }),
  }
}

export function canvasWire(canvas: SpatialCanvas, hex: Hex): CanvasWire {
  return {
    ...(canvas.facets === undefined ? {} : { facets: canvas.facets }),
    ...(canvas.tags === undefined ? {} : { tags: canvas.tags }),
    nodes: canvas.nodes.map((node) => nodeWire(node, hex)),
    edges: canvas.edges.map((edge) => elementWire(edge, hex)),
    ...(canvas.lines === undefined ? {} : { lines: canvas.lines.map((l) => elementWire(l, hex)) }),
  }
}
