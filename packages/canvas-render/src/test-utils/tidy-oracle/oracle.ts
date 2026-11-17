import { readFileSync } from 'node:fs'
import type { CanvasEdge } from '@kamiazya/whiteboard-model'
import { type TidyNode, tidyBoxes, tidyNodes } from '../../tidy.js'
import { DRAWING_CORPUS } from '../drawing-corpus.js'
import { mulberry32 } from '../scene-digest-oracle/spec.js'
import { EXTRA_CASES } from './extras.js'
import { seededCases } from './seeded.js'

/**
 * What `tidyNodes` answers, recorded for the Rust port to replay (ADR-0054
 * step 7, the tidy slice). A record holds its INPUT as well as its answer, so
 * the replaying crate needs no corpus and no generator.
 *
 * Three kinds of input reach it:
 * - `drawing`: every board of the drawing corpus, each as drawn and again after
 *   its own tidy, with its edges;
 * - `test`: every distinct call the package's own tidy suites make (the examples,
 *   the quality corpus, and a sample of each property's draws), captured once into
 *   `from-tests.json`;
 * - `extra`: the ceilings, and the totality edges;
 * - `seeded`: boards drawn once from `META.seed` and committed as data, dense in
 *   what tidy branches on (rows and columns a few pixels off, centres and far
 *   edges, overlaps, frames straddled and nested, locks, scopes, edges, and
 *   degenerate sizes and ids).
 *
 * A number JSON cannot hold is written by name (`nan`, `inf`, `-inf`).
 */

export type Num = number | 'nan' | 'inf' | '-inf'

/** `[id, frame (0 or 1), x, y, width, height]`. */
export type Row = readonly [string, 0 | 1, Num, Num, Num, Num]

/** An edge by the node ids its ends name; `null` is a free end. */
export type EdgeSpec = readonly [string | null, string | null]

export interface TidyCase {
  readonly id: string
  readonly nodes: readonly Row[]
  /** The ids a scope names; absent = the whole canvas. */
  readonly scope?: readonly string[]
  /** The ids `locked` answers true for. */
  readonly locked?: readonly string[]
  readonly edges?: readonly EdgeSpec[]
}

/** `[id, x, y]`, or `[id, x, y, width, height]` for a frame that grew. */
export type Move =
  | readonly [string, number, number]
  | readonly [string, number, number, number, number]

export type OracleRecord =
  | { readonly k: 'meta'; readonly seed: number; readonly boards: number }
  | ({ readonly k: 'drawing' | 'test' | 'extra' | 'seeded' } & TidyCase & {
        readonly m: readonly Move[]
      })

/** The calls the package's tidy suites make, captured once (see the header). */
const TEST_CASES = JSON.parse(
  readFileSync(new URL('./from-tests.json', import.meta.url), 'utf8'),
) as TidyCase[]

export const META = { seed: 0x71d7_0a11, boards: 1200 }

const NUM: Record<string, number> = {
  nan: Number.NaN,
  inf: Number.POSITIVE_INFINITY,
  '-inf': Number.NEGATIVE_INFINITY,
}

export const numOf = (n: Num): number => (typeof n === 'number' ? n : (NUM[n] as number))

/** A number as the recording holds it. */
export const numName = (n: number): Num => {
  if (Number.isNaN(n)) return 'nan'
  if (n === Number.POSITIVE_INFINITY) return 'inf'
  if (n === Number.NEGATIVE_INFINITY) return '-inf'
  return n
}

export const nodesOf = (rows: readonly Row[]): TidyNode[] =>
  rows.map(([id, frame, x, y, width, height]) => ({
    id,
    frame: frame === 1,
    x: numOf(x),
    y: numOf(y),
    width: numOf(width),
    height: numOf(height),
  }))

const edgeOf = ([from, to]: EdgeSpec): CanvasEdge =>
  ({
    id: 'e',
    from: from === null ? { kind: 'point', x: 0, y: 0 } : { kind: 'node', node: from },
    to: to === null ? { kind: 'point', x: 0, y: 0 } : { kind: 'node', node: to },
  }) as unknown as CanvasEdge

/** The moves `tidyNodes` answers for a case, as the recording holds them. */
export function answerOf(c: TidyCase): Move[] {
  const locked = c.locked === undefined ? undefined : new Set(c.locked)
  return tidyNodes(nodesOf(c.nodes), {
    ...(c.scope === undefined ? {} : { scope: new Set(c.scope) }),
    ...(locked === undefined ? {} : { locked: (id: string) => locked.has(id) }),
    ...(c.edges === undefined ? {} : { edges: c.edges.map(edgeOf) }),
  }).map((m) =>
    m.width === undefined || m.height === undefined
      ? ([m.id, m.x, m.y] as const)
      : ([m.id, m.x, m.y, m.width, m.height] as const),
  )
}

/** Every drawing-corpus board, as drawn and after one tidy of its own. */
export function drawingCases(): TidyCase[] {
  return DRAWING_CORPUS.flatMap(({ name, canvas }) => {
    const rows = (nodes: readonly TidyNode[]): Row[] =>
      nodes.map((n) => [n.id, n.frame ? 1 : 0, n.x, n.y, n.width, n.height])
    const edges = canvas.edges.map(
      (e): EdgeSpec => ['node' in e.from ? e.from.node : null, 'node' in e.to ? e.to.node : null],
    )
    const drawn: TidyCase = { id: `${name}`, nodes: rows(tidyBoxes(canvas.nodes)), edges }
    const moves = new Map(answerOf(drawn).map((m) => [m[0], m] as const))
    const after: TidyCase = {
      id: `${name}/again`,
      edges,
      nodes: drawn.nodes.map(([id, f, x, y, w, h]) => {
        const m = moves.get(id)
        return m === undefined ? [id, f, x, y, w, h] : [id, f, m[1], m[2], m[3] ?? w, m[4] ?? h]
      }),
    }
    const first = canvas.nodes[0]?.id
    const scoped: TidyCase = {
      id: `${name}/scoped`,
      nodes: drawn.nodes,
      edges,
      scope: first === undefined ? [] : [first],
    }
    const lockedFirst: TidyCase = {
      id: `${name}/locked`,
      nodes: drawn.nodes,
      edges,
      locked: first === undefined ? [] : [first],
    }
    return [drawn, after, scoped, lockedFirst]
  })
}

export function recording(): OracleRecord[] {
  const kinds: [OracleRecord['k'], TidyCase[]][] = [
    ['drawing', drawingCases()],
    ['extra', EXTRA_CASES],
    ['test', TEST_CASES],
    ['seeded', seededCases(mulberry32(META.seed), META.boards)],
  ]
  return [
    { k: 'meta', ...META },
    ...kinds.flatMap(([k, cases]) =>
      cases.map((c) => ({ k, ...c, m: answerOf(c) }) as OracleRecord),
    ),
  ]
}
