import type { EdgeRoutingStyle, EdgeSide, SpatialNode } from '@kamiazya/whiteboard-model'
import type { ResolvedEdgeNode, RoutableElement } from '@kamiazya/whiteboard-scene'
import type { LabelRect, RoutingBudget, SideOverride } from './types.js'
import { encodeLayout, sideAt } from './wire.js'

/** The glue surface the shim calls: the `#glue` module's own type. */
export type CoreGlue = typeof import('#glue')

/** The ABI this shim was written against; an artifact speaking another is refused at init. */
export const EXPECTED_ABI = '13'

/** The artifact speaks another ABI than this shim: the two came from different commits. */
export class CoreAbiMismatch extends Error {
  constructor(readonly found: string) {
    super(`the wasm artifact speaks ABI ${found}, this shim ${EXPECTED_ABI}; rebuild it`)
    this.name = 'CoreAbiMismatch'
  }
}

/** The artifact refused its input, which this shim built: a shim defect, never the caller's. */
export class CoreInputRefused extends Error {
  constructor(readonly operation: string) {
    super(`${operation} refused the input this shim encoded`)
    this.name = 'CoreInputRefused'
  }
}

/** An initialised core: one call per user operation (QR-22b). */
export interface Core {
  /**
   * One layout's edge routing, as canvas-render's composer runs it between
   * `assignEdgeAnchors` and its per-edge `routeEdge`: every edge of `edges`
   * routed in order, on `budget`, whose four accounts are written back.
   */
  routeLayout(
    nodes: readonly SpatialNode[],
    edges: readonly RoutableElement[],
    styleOf: (edge: RoutableElement) => EdgeRoutingStyle,
    overrides: ReadonlyMap<string, SideOverride> | undefined,
    budget: RoutingBudget,
    labels: readonly LabelRect[],
  ): ResolvedEdgeNode[]
}

const ends = ['none', 'arrow'] as const

/** The routes in `out`, or undefined when it does not hold exactly one per edge. */
function decodeRoutes(
  out: Float64Array,
  edges: readonly RoutableElement[],
): ResolvedEdgeNode[] | undefined {
  if (out.length < 5 || out[4] !== edges.length) return undefined
  let at = 5
  const routes = edges.map((edge): ResolvedEdgeNode => {
    const [rounded, fromSide, toSide, fromEnd, toEnd, n] = out.subarray(at, at + 6)
    const path = Array.from({ length: n ?? 0 }, (_, i) => ({
      x: out[at + 6 + 2 * i] as number,
      y: out[at + 7 + 2 * i] as number,
    }))
    at += 6 + 2 * path.length
    return {
      kind: 'edge',
      id: edge.id,
      path,
      ...(rounded === 1 ? { rounded: true as const } : {}),
      fromSide: sideAt(fromSide as number) as EdgeSide,
      toSide: sideAt(toSide as number) as EdgeSide,
      fromEnd: ends[fromEnd as number] ?? 'none',
      toEnd: ends[toEnd as number] ?? 'none',
    }
  })
  // Every number accounted for: a garbled answer is refused, not half read.
  return at === out.length ? routes : undefined
}

/**
 * A core over glue that is already loaded, initialised from `source` (the
 * artifact's bytes or a compiled module the composition root holds).
 * Synchronous, for a root that has the glue in hand, such as a worker.
 */
export function coreFrom(glue: CoreGlue, source: BufferSource | WebAssembly.Module): Core {
  glue.initSync({ module: source })
  const abi = glue.abi_version()
  if (abi !== EXPECTED_ABI) throw new CoreAbiMismatch(abi)
  return {
    routeLayout(nodes, edges, styleOf, overrides, budget, labels) {
      const wire = encodeLayout(nodes, edges, styleOf, overrides, budget, labels)
      const out = glue.edge_route_layout(wire.input)
      const routes = decodeRoutes(out, edges)
      if (routes === undefined) throw new CoreInputRefused('edge_route_layout')
      budget.grid = out[0] as number
      budget.pairs = out[1] as number
      budget.trials = out[2] as number
      budget.repairs = out[3] as number
      return routes
    },
  }
}

/**
 * The core, from the artifact's bytes or a compiled module. The glue is
 * imported only here, so nothing loads until a root asks for it.
 */
export async function loadCore(source: BufferSource | WebAssembly.Module): Promise<Core> {
  return coreFrom(await import('#glue'), source)
}
