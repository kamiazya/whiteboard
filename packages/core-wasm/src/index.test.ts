import type { SpatialNode } from '@kamiazya/whiteboard-model'
import type { RoutableElement } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import {
  CoreAbiMismatch,
  type CoreGlue,
  CoreInputRefused,
  coreFrom,
  EXPECTED_ABI,
} from './index.js'
import type { RoutingBudget } from './types.js'

/** A glue that answers `out` to every routing call and records what it was sent. */
function fakeGlue(abi: string, out: number[]) {
  const sent: Float64Array[] = []
  const glue: CoreGlue = {
    initSync: () => undefined,
    abi_version: () => abi,
    edge_route_layout: (input) => {
      sent.push(input)
      return Float64Array.from(out)
    },
  }
  return { glue, sent }
}

const box = (id: string, x: number): SpatialNode =>
  ({ id, type: 'text', text: '', x, y: 0, width: 100, height: 50 }) as SpatialNode
const nodes = [box('a', 0), box('b', 300)]
const edge: RoutableElement = {
  id: 'e',
  from: { node: 'a', side: 'right' },
  to: { node: 'b', end: 'arrow' },
}
const budget = (): RoutingBudget => ({ grid: 100, pairs: 200, trials: 300, repairs: 400 })

describe('the core-wasm shim', () => {
  it('refuses an artifact that speaks another ABI', () => {
    const { glue } = fakeGlue('0', [])
    expect(() => coreFrom(glue, new Uint8Array())).toThrow(CoreAbiMismatch)
  })

  it('treats an artifact refusing its input as its own defect', () => {
    const { glue } = fakeGlue(EXPECTED_ABI, [])
    const core = coreFrom(glue, new Uint8Array())
    expect(() =>
      core.routeLayout(nodes, [edge], () => 'straight', undefined, budget(), []),
    ).toThrow(CoreInputRefused)
  })

  it('refuses an answer that routes another number of edges, or leaves numbers over', () => {
    for (const out of [
      [0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 9],
    ]) {
      const { glue } = fakeGlue(EXPECTED_ABI, out)
      const b = budget()
      expect(() =>
        coreFrom(glue, new Uint8Array()).routeLayout(
          nodes,
          [edge],
          () => 'straight',
          undefined,
          b,
          [],
        ),
      ).toThrow(CoreInputRefused)
      // Refused before anything is written back.
      expect(b).toEqual(budget())
    }
  })

  it('encodes one layout as the wire the export decodes', () => {
    const { glue, sent } = fakeGlue(
      EXPECTED_ABI,
      [0, 0, 0, 0, 1, 0, 1, 3, 0, 1, 2, 100, 25, 300, 25],
    )
    const label = { x: 10, y: 20, w: 30, h: 40 }
    coreFrom(glue, new Uint8Array()).routeLayout(
      nodes,
      [edge],
      () => 'orthogonal',
      undefined,
      budget(),
      [label],
    )
    // nodes; edges (id, from: node a, side right, no arrowhead; to: node b,
    // no side, arrow; no bends); one style; no overrides; one label; the budget.
    expect([...(sent[0] as Float64Array)]).toEqual([
      2,
      0,
      0,
      0,
      100,
      50,
      1,
      300,
      0,
      100,
      50,
      1,
      0,
      0,
      0,
      Number.NaN,
      1,
      -1,
      0,
      1,
      Number.NaN,
      -1,
      1,
      -1,
      1,
      0,
      1,
      10,
      20,
      30,
      40,
      100,
      200,
      300,
      400,
    ])
  })

  it('encodes overrides it can name and drops those naming no edge', () => {
    const { glue, sent } = fakeGlue(EXPECTED_ABI, [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0])
    const overrides = new Map([
      [
        'e',
        {
          fromSide: 'left' as const,
          toSide: 'top' as const,
          around: true as const,
          from: { x: 1, y: 2 },
          fromLaneDepth: 7,
          to: { x: 3, y: 4 },
          toLaneDepth: 9,
        },
      ],
      ['gone', { fromSide: 'left' as const, toSide: 'top' as const }],
    ])
    coreFrom(glue, new Uint8Array()).routeLayout(
      nodes,
      [edge],
      () => 'straight',
      overrides,
      budget(),
      [],
    )
    const input = [...(sent[0] as Float64Array)]
    // After the one style: present, one entry, edge 0, left, top, around,
    // from pinned at (1, 2), its lane 7, to pinned at (3, 4), its lane 9.
    expect(input.slice(25, 25 + 16)).toEqual([1, 1, 0, 3, 0, 1, 1, 1, 2, 1, 7, 1, 3, 4, 1, 9])
  })

  it('decodes every route in order and writes the four accounts back', () => {
    const out = [7, 8, 9, 10, 2, 1, 1, 3, 0, 1, 2, 100, 25, 300, 25, 0, 2, 0, 1, 0, 0]
    const { glue } = fakeGlue(EXPECTED_ABI, out)
    const b = budget()
    const routes = coreFrom(glue, new Uint8Array()).routeLayout(
      nodes,
      [edge, { ...edge, id: 'f' }],
      () => 'straight',
      undefined,
      b,
      [],
    )
    expect(b).toEqual({ grid: 7, pairs: 8, trials: 9, repairs: 10 })
    expect(routes).toEqual([
      {
        kind: 'edge',
        id: 'e',
        path: [
          { x: 100, y: 25 },
          { x: 300, y: 25 },
        ],
        rounded: true,
        fromSide: 'right',
        toSide: 'left',
        fromEnd: 'none',
        toEnd: 'arrow',
      },
      {
        kind: 'edge',
        id: 'f',
        path: [],
        fromSide: 'bottom',
        toSide: 'top',
        fromEnd: 'arrow',
        toEnd: 'none',
      },
    ])
  })
})
