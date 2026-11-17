import type { NodePatchFields } from '@kamiazya/whiteboard-model'
import type { ElementWire, EndWire, NodeWire } from '../compose-canvas-oracle/wire.js'

/**
 * A proposed change as the Rust replay reads it: the canvas wire's nodes,
 * edges and lines, a patch's doubles as the hex of their bits and its ends and
 * bends as the canvas wire writes them. A `body.replace` carries only what the
 * canvas reads of it, its identity and verdict.
 */

type NodePatchWire = Omit<NodePatchFields, 'x' | 'y' | 'width' | 'height'> & {
  readonly x?: string
  readonly y?: string
  readonly width?: string
  readonly height?: string
}

interface ElementPatchWire {
  readonly from?: EndWire
  readonly to?: EndWire
  readonly color?: string
  readonly label?: string
  readonly bends?: readonly (readonly string[])[]
  readonly facets?: unknown
}

export interface ChangeWire {
  readonly id: string
  readonly status: string
  readonly op: string
  readonly node?: NodeWire
  readonly nodeId?: string
  readonly edge?: ElementWire
  readonly edgeId?: string
  readonly line?: ElementWire
  readonly lineId?: string
  readonly patch?: NodePatchWire | ElementPatchWire
  readonly assumed?: NodePatchWire | ElementPatchWire | NodeWire | ElementWire
}
