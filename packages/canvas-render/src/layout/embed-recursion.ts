import type { EmbedPlaceholderNode, EmbedResolvedNode } from '../scene-graph.js'

/**
 * Minimal, internal/versioned input seam for embed recursion. Consumed
 * later by canvas-workspace's View-resolution layer; this package treats it
 * as an opaque lookup and extends it additively if a future slice needs
 * more fields.
 */
export interface DocRef {
  readonly canvasId: string
  readonly version?: string
}

export interface ResolvedDoc {
  readonly canvasId: string
  readonly title?: string
  /** Ordered canvasIds this doc embeds. */
  readonly embeds: readonly string[]
}

export type ResolvedDocBundleEntry = ResolvedDoc | { readonly unresolved: true }

export interface ResolvedDocBundle {
  readonly root: DocRef
  readonly docs: Record<string, ResolvedDocBundleEntry>
}

/** Root depth is 0; a 4th nesting level (depth 3 embedding depth 4) is the cap hit. */
const DEPTH_CAP = 3

const ZERO_BBOX = { x: 0, y: 0, w: 0, h: 0 }

function placeholder(
  canvasId: string,
  reason: EmbedPlaceholderNode['reason'],
  title?: string,
): EmbedPlaceholderNode {
  return { kind: 'embedPlaceholder', bbox: ZERO_BBOX, canvasId, title: title ?? canvasId, reason }
}

/**
 * Recursively resolves an embed bundle into a scene node. Total: never
 * throws, never infinite-loops, on any bundle including dense cyclic ones.
 * Cycle detection is PATH-LOCAL — a re-visit of a canvasId on the current
 * recursion path is a placeholder, but the same doc reached again via a
 * disjoint path renders normally.
 */
export function resolveEmbeds(bundle: ResolvedDocBundle): EmbedResolvedNode | EmbedPlaceholderNode {
  return resolveNode(bundle, bundle.root.canvasId, 0, [])
}

function resolveNode(
  bundle: ResolvedDocBundle,
  canvasId: string,
  depth: number,
  pathVisited: readonly string[],
): EmbedResolvedNode | EmbedPlaceholderNode {
  const entry = bundle.docs[canvasId]
  const knownTitle = entry && 'embeds' in entry ? entry.title : undefined

  if (pathVisited.includes(canvasId)) {
    return placeholder(canvasId, 'cycle', knownTitle)
  }
  if (depth > DEPTH_CAP) {
    return placeholder(canvasId, 'depthCap', knownTitle)
  }
  if (!entry || 'unresolved' in entry) {
    return placeholder(canvasId, 'unresolvable')
  }

  const nextPath = [...pathVisited, canvasId]
  const children = entry.embeds.map((childId) => resolveNode(bundle, childId, depth + 1, nextPath))

  return { kind: 'embedResolved', bbox: ZERO_BBOX, canvasId, children }
}
