/**
 * Pure clipboard-fragment helpers (editor-completeness slice 2). The
 * fragment format itself is model's `clipboardFragmentSchema`;
 * these two functions are the only bridge between a live canvas and that
 * envelope:
 *
 * - `extractClipboardFragment` builds a SELF-CONTAINED fragment from a
 *   selection — nodes in canvas (z) order, edges only when both
 *   endpoints are selected, so the result always parses.
 * - `remintClipboardFragment` makes a paste collision-free — every node
 *   id is reminted via the injected id factory (never colliding with the
 *   target canvas's ids or each other), edge endpoints are remapped, and
 *   edges whose endpoints are not both in the fragment are dropped
 *   (defensive against hand-built foreign input that skipped the schema).
 */
import type {
  CanvasEdge,
  ClipboardFragment,
  SpatialCanvas,
  SpatialNode,
} from '@kamiazya/whiteboard-model'
import { clipboardFragmentSchema } from '@kamiazya/whiteboard-model'

/**
 * Our fragment parsed out of clipboard TEXT, or null for anything else —
 * non-JSON, foreign JSON (a different `type` discriminant), or a shape the
 * schema rejects. Callers degrade a null to a plain-text note, so this must
 * never throw.
 */
export function parseClipboardText(text: string): ClipboardFragment | null {
  if (text.trim() === '') return null
  try {
    const parsed = clipboardFragmentSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function extractClipboardFragment(
  canvas: SpatialCanvas,
  selectedIds: ReadonlySet<string>,
  options?: { readonly cutId?: string },
): ClipboardFragment {
  const nodes = canvas.nodes.filter((node) => selectedIds.has(node.id))
  const included = new Set(nodes.map((node) => node.id))
  const edges = canvas.edges.filter(
    (edge) => included.has(edge.fromNode) && included.has(edge.toNode),
  )
  const base = { type: 'whiteboard/clipboard', version: 1, nodes, edges } as const
  if (options?.cutId === undefined) return base
  // A cut also records its cut surface — the edges it severs (exactly one
  // endpoint selected) — so a same-canvas paste can reconnect them. The
  // fragment proper stays self-contained; peers live only on the source.
  const boundaryEdges = canvas.edges.filter(
    (edge) => included.has(edge.fromNode) !== included.has(edge.toNode),
  )
  return { ...base, cut: { id: options.cutId, boundaryEdges } }
}

export interface RemintedFragment {
  readonly nodes: readonly SpatialNode[]
  readonly edges: readonly CanvasEdge[]
  /** Source id → reminted id, for reconnecting a cut's boundary edges. */
  readonly idMap: ReadonlyMap<string, string>
  /** Mints further ids from the same collision-free pool (boundary edges). */
  readonly mintId: () => string
}

export function remintClipboardFragment(
  fragment: Pick<ClipboardFragment, 'nodes' | 'edges'>,
  createId: () => string,
  existingIds: ReadonlySet<string>,
): RemintedFragment {
  const taken = new Set(existingIds)
  const freshId = () => {
    let id = createId()
    while (taken.has(id)) id = createId()
    taken.add(id)
    return id
  }

  const idMap = new Map<string, string>()
  const nodes = fragment.nodes.map((node) => {
    const id = freshId()
    idMap.set(node.id, id)
    return { ...node, id }
  })
  const edges = fragment.edges.flatMap((edge) => {
    const fromNode = idMap.get(edge.fromNode)
    const toNode = idMap.get(edge.toNode)
    if (fromNode === undefined || toNode === undefined) return []
    return [{ ...edge, id: freshId(), fromNode, toNode }]
  })
  return { nodes, edges, idMap, mintId: freshId }
}
