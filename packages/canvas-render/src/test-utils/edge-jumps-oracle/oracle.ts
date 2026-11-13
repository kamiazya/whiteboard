import type { ResolvedEdgeNode } from '@kamiazya/whiteboard-scene'
import { computeEdgeJumps } from '../../layout/edges/edge-jumps.js'
import { f64Hex } from '../render-oracle/scene-dump.js'
import { BOARDS, type Board } from './corpus.js'

/**
 * The recorded answers of `computeEdgeJumps` (`layout/edges/edge-jumps.ts`):
 * for each board, every edge's id and path as handed in, and the hops it
 * answers, by edge id in the map's own order, each as its segment and point.
 * Every double is the hex of its IEEE bits, a NaN the canonical one.
 */

const hex = (value: number): string => (Number.isNaN(value) ? '7ff8000000000000' : f64Hex(value))

export interface EdgeJumpsRecord {
  readonly id: string
  readonly edges: readonly (readonly [string, readonly (readonly [string, string])[]])[]
  readonly jumps: readonly (readonly [string, readonly (readonly [number, string, string])[]])[]
}

/** An edge as the composer hands it over: only its id and path are read. */
const routed = (id: string, path: readonly (readonly [number, number])[]): ResolvedEdgeNode =>
  ({ kind: 'edge', id, path: path.map(([x, y]) => ({ x, y })) }) as unknown as ResolvedEdgeNode

function record(board: Board): EdgeJumpsRecord {
  const answer = computeEdgeJumps(board.edges.map(({ id, path }) => routed(id, path)))
  return {
    id: board.id,
    edges: board.edges.map(({ id, path }) => [id, path.map(([x, y]) => [hex(x), hex(y)] as const)]),
    jumps: [...answer].map(([id, points]) => [
      id,
      points.map((p) => [p.segment, hex(p.x), hex(p.y)] as const),
    ]),
  }
}

export const edgeJumpsRecords = (): EdgeJumpsRecord[] => BOARDS.map(record)
