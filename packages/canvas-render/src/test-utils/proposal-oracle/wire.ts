import type { NodePatchFields, Proposal, ProposedChange } from '@kamiazya/whiteboard-model'
import { hex } from '../compose-canvas-oracle/oracle.js'
import {
  type ElementWire,
  type EndWire,
  elementWire,
  endWire,
  type NodeWire,
  nodeWire,
} from '../compose-canvas-oracle/wire.js'

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

export interface ProposalWire {
  readonly id: string
  readonly changes: readonly ChangeWire[]
}

const NUMBERS = ['x', 'y', 'width', 'height'] as const

function nodePatchWire(patch: NodePatchFields): NodePatchWire {
  const out: Record<string, unknown> = { ...patch }
  for (const key of NUMBERS) {
    const value = patch[key]
    if (value !== undefined) out[key] = hex(value)
  }
  return out as NodePatchWire
}

type ElementPatch = Extract<ProposedChange, { op: 'edge.patch' | 'line.patch' }>['patch']

function elementPatchWire(patch: ElementPatch): ElementPatchWire {
  const { from, to, bends, ...rest } = patch
  return {
    ...rest,
    ...(from === undefined ? {} : { from: endWire(from, hex) }),
    ...(to === undefined ? {} : { to: endWire(to, hex) }),
    ...(bends === undefined ? {} : { bends: bends.map((b) => [hex(b.x), hex(b.y)]) }),
  }
}

export function changeWire(change: ProposedChange): ChangeWire {
  const head = { id: change.id, status: change.status, op: change.op }
  switch (change.op) {
    case 'node.add':
      return { ...head, node: nodeWire(change.node, hex) }
    case 'node.patch':
      return {
        ...head,
        nodeId: change.nodeId,
        patch: nodePatchWire(change.patch),
        assumed: nodePatchWire(change.assumed),
      }
    case 'node.remove':
      return { ...head, nodeId: change.nodeId, assumed: nodeWire(change.assumed, hex) }
    case 'edge.add':
      return { ...head, edge: elementWire(change.edge, hex) }
    case 'edge.patch':
      return {
        ...head,
        edgeId: change.edgeId,
        patch: elementPatchWire(change.patch),
        assumed: elementPatchWire(change.assumed),
      }
    case 'edge.remove':
      return { ...head, edgeId: change.edgeId, assumed: elementWire(change.assumed, hex) }
    case 'line.add':
      return { ...head, line: elementWire(change.line, hex) }
    case 'line.patch':
      return {
        ...head,
        lineId: change.lineId,
        patch: elementPatchWire(change.patch),
        assumed: elementPatchWire(change.assumed),
      }
    case 'line.remove':
      return { ...head, lineId: change.lineId, assumed: elementWire(change.assumed, hex) }
    case 'body.replace':
      return head
  }
}

export const proposalWire = (proposal: Proposal): ProposalWire => ({
  id: proposal.id,
  changes: proposal.changes.map(changeWire),
})
