import type { CanvasEdge, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'

export interface NodeWire extends Omit<SpatialNode, 'x' | 'y' | 'width' | 'height'> {
  readonly box: readonly string[]
}

export interface EndWire {
  readonly node?: string
  readonly point?: readonly string[]
  readonly side?: string
  readonly end?: string
}

export interface ElementWire {
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
