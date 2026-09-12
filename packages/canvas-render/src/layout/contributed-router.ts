/**
 * Resolving the edge ALGORITHM a contribution supplies.
 *
 * It sits beside the composer rather than in `layout/edges/`: the routers
 * are a plugin's, and what selects one is the contribution set the composer
 * resolved, which the edge cluster deliberately knows nothing about.
 */
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { endNode } from '@kamiazya/whiteboard-model'
import type {
  BoundingBox,
  EdgeRouteRequest,
  EdgeRouter,
  RenderContribution,
  ResolvedEdgeNode,
  RoutableElement,
} from '@kamiazya/whiteboard-scene'
import type { EdgeAnchorPair } from './edges/spatial-edges.js'

/** What selecting a router takes: who may answer, and what they registered. */
interface RouterResolution {
  readonly contributions: readonly RenderContribution[]
  readonly routerTable: Readonly<Record<string, EdgeRouter>>
}

/**
 * The composed router table, by namespaced id — the same composition the
 * shape table gets, so a document naming `visual.orbit` reaches the plugin
 * that declared `orbit` and cannot reach another's by writing a namespace.
 */
export function resolveRouterTable(
  contributions: readonly RenderContribution[],
): Readonly<Record<string, EdgeRouter>> {
  const table: Record<string, EdgeRouter> = {}
  for (const contribution of contributions) {
    for (const [name, router] of Object.entries(contribution.routers ?? {})) {
      table[`${contribution.namespace}.${name}`] = router
    }
  }
  return table
}

const boxOf = (node: SpatialNode): BoundingBox => ({
  x: node.x,
  y: node.y,
  w: node.width,
  h: node.height,
})

/**
 * A contributed router's answer, already shaped as the scene edge the rest
 * of the pipeline expects — or undefined when no router answers, so the
 * caller falls back.
 *
 * The router is handed BOXES and the sides the anchor pass chose, never the
 * nodes: a route needs geometry, not a node's content, and the sides are its
 * input rather than its answer. What it returns is points, and everything
 * after — terminating on a silhouette, the arrowheads, the paint, the ink —
 * stays with the composer, so a router cannot become a second producer of
 * that geometry.
 */
export function contributedRoute(
  canvas: SpatialCanvas,
  edge: RoutableElement,
  resolution: RouterResolution,
  anchors: EdgeAnchorPair | undefined,
): ResolvedEdgeNode | undefined {
  const router = routerFor(canvas, edge, resolution)
  if (router === undefined) return undefined
  const from = canvas.nodes.find((node) => node.id === endNode(edge.from))
  const to = canvas.nodes.find((node) => node.id === endNode(edge.to))
  if (from === undefined || to === undefined) return undefined
  const request: EdgeRouteRequest = {
    edge,
    from: boxOf(from),
    to: boxOf(to),
    obstacles: canvas.nodes
      .filter((node) => node.id !== endNode(edge.from) && node.id !== endNode(edge.to))
      .map(boxOf),
    // Passed only when BOTH sides resolved, so the contract can promise a
    // router that anchors means sides. A half-answer would make every router
    // repeat the same "and if the side is missing" branch.
    anchors:
      anchors?.fromSide === undefined || anchors.toSide === undefined
        ? undefined
        : {
            fromSide: anchors.fromSide,
            toSide: anchors.toSide,
            ...(anchors.from === undefined ? {} : { from: anchors.from }),
            ...(anchors.to === undefined ? {} : { to: anchors.to }),
          },
  }
  const route = router(request)
  if (route === null || route.path.length < 2) return undefined
  return {
    kind: 'edge',
    id: edge.id,
    path: route.path,
    fromSide: anchors?.fromSide ?? 'right',
    toSide: anchors?.toSide ?? 'left',
    fromEnd: edge.from.end ?? 'none',
    toEnd: edge.to.end ?? 'arrow',
    ...(route.rounded === true ? { rounded: true as const } : {}),
  }
}

/**
 * The router a contribution selects for this edge, by asking each in turn —
 * the same shape `resolveNodeOutlines` uses for silhouettes. A bare name is
 * namespaced by the contribution that answered, so a plugin can only reach
 * its own; a name it did not register resolves to nothing and the built-in
 * draws, which is the degradation an unknown shape id already gets.
 */
function routerFor(
  canvas: SpatialCanvas,
  edge: RoutableElement,
  resolution: RouterResolution,
): EdgeRouter | undefined {
  for (const contribution of resolution.contributions) {
    const name = contribution.readRouting?.(edge, canvas)
    if (name === undefined) continue
    const router = resolution.routerTable[`${contribution.namespace}.${name}`]
    if (router !== undefined) return router
  }
  return undefined
}
