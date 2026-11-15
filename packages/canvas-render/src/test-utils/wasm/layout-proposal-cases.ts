import type {
  CanvasEdge,
  CanvasLine,
  Proposal,
  ProposedChange,
  SpatialCanvas,
  SpatialNode,
} from '@kamiazya/whiteboard-model'
import type { SpatialLayoutOptions } from '../../layout/layout-options.js'
import { createSpatialTheme } from '../../theme/spatial-theme.js'
import { createFakeMeasure } from '../fake-measure.js'
import { proposalBoards } from '../proposal-oracle/layer-corpus.js'

/** A proposal case, before `layout-cases.ts` gives it its topic. */
export interface ProposalCase {
  readonly name: string
  readonly canvas: SpatialCanvas
  readonly options: SpatialLayoutOptions
}

/** A copy that shares no object with what it was made from, as a prior read from the record. */
const copy = <T>(value: T): T => structuredClone(value)

/** The same mapping with its keys in the reverse order, at every depth. */
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, item]) => [key, reversed(item)]),
  )
}

const FACETS = { 'x.note/v0': { a: 1, b: [1, { c: 2 }] }, 'x.tag/v0': { t: 'y' } }

const change = (id: string, body: object): ProposedChange =>
  ({ id, status: 'open', ...body }) as unknown as ProposedChange

const alone = (id: string, body: object): Proposal => ({ id, changes: [change(`${id}-c`, body)] })

const pointEnd = (x: number, y: number) => ({ kind: 'point', point: { x, y } }) as const

/**
 * Priors that agree with the board only BY VALUE (a copy, a facet bucket's
 * keys reversed, an end or a bend list rebuilt), beside priors one value off,
 * each change its own proposal so each bubble's label says which it is.
 */
function priorProposals(canvas: SpatialCanvas): Proposal[] {
  const node = (id: string) => canvas.nodes.find((n) => n.id === id) as SpatialNode
  const edge = (id: string) => canvas.edges.find((e) => e.id === id) as CanvasEdge
  const line = (id: string) => (canvas.lines ?? []).find((l) => l.id === id) as CanvasLine
  const e1 = edge('e1')
  return [
    alone('agrees-node', { op: 'node.remove', nodeId: 'a', assumed: copy(node('a')) }),
    alone('stale-node', { op: 'node.remove', nodeId: 'c', assumed: { ...node('c'), x: 1 } }),
    alone('agrees-edge', { op: 'edge.remove', edgeId: 'e1', assumed: reversed(e1) }),
    alone('agrees-facets', {
      op: 'edge.patch',
      edgeId: 'e1',
      patch: { facets: {}, bends: [] },
      assumed: { facets: reversed(e1.facets), bends: copy(e1.bends) },
    }),
    alone('stale-bend', {
      op: 'edge.patch',
      edgeId: 'e1',
      patch: { bends: [] },
      assumed: { bends: [{ x: 300, y: -81 }] },
    }),
    alone('agrees-end', {
      op: 'line.patch',
      lineId: 'k1',
      patch: { from: pointEnd(0, 0), label: 'ink' },
      assumed: { from: copy(line('k1').from) },
    }),
    alone('stale-end', {
      op: 'line.patch',
      lineId: 'k2',
      patch: { to: pointEnd(0, 0) },
      assumed: { to: pointEnd(700, -149) },
    }),
    alone('agrees-line', { op: 'line.remove', lineId: 'k2', assumed: reversed(line('k2')) }),
  ]
}

/**
 * The compose-comments recording's proposal boards (every arm outlined, the
 * arms that draw nothing, conflicts counted into a label, a crowd fanned
 * round one node) laid out whole in both modes and under a drawn style and
 * the document's own, the mixed board with its comment layer drawn too, and the
 * first board again with priors compared by value: agreeing copies and ones
 * a value off.
 */
export function proposalCases(): ProposalCase[] {
  const measure = createFakeMeasure()
  const boards = proposalBoards()
  const styles = [
    ['light', 'light', undefined],
    ['dark', 'dark', undefined],
    ['dark sketch', 'dark', 'visual.sketch'],
    ['document', 'light', 'document'],
  ] as const
  const swept = boards.flatMap((board) =>
    styles.map(([label, mode, style]) => ({
      name: `${board.name} ${label}`,
      canvas: board.canvas,
      options: {
        measure,
        appearance: createSpatialTheme({ mode }),
        ...(style === undefined ? {} : { style }),
        proposals: board.proposals,
        ...(board.threads.length > 0 ? { threads: board.threads } : { commentLayer: false }),
      },
    })),
  )
  const arms = boards[0]
  if (arms === undefined) return swept
  const [e1, ...edges] = arms.canvas.edges
  const canvas = {
    ...arms.canvas,
    edges: [{ ...e1, bends: [{ x: 300, y: -80 }], facets: FACETS } as CanvasEdge, ...edges],
  }
  const priors = {
    name: 'priors by value',
    canvas,
    options: {
      measure,
      appearance: createSpatialTheme({ mode: 'light' }),
      proposals: priorProposals(canvas),
    },
  }
  return [...swept, priors]
}
