/**
 * What the inspector's stencil row becomes as editor commands.
 *
 * A stencil is two things on a node (ADR-0034 decision 5): its appearance
 * EXPANDED onto the node, and its id RECORDED under `visual.stencil/v0`. The
 * panel is a derived form that writes only the record, so left alone a chosen
 * stencil changes nothing on the board while the same choice through
 * `wb_canvas_edit` draws it. The expansion is `applyStencil`'s — the function
 * that tool runs — and this module only turns its answer into the leaf
 * commands the editor already has, so there is one definition of what a
 * stencil writes and the two surfaces cannot drift.
 *
 * The commands are leaf `set-node-facet` / `set-node-color` writes rather
 * than a new command kind: `commands.ts` stays facet-generic, and undo, the
 * eager chain and sync see nothing they did not already.
 */
import type { FacetRegistry } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import {
  applyStencil,
  bundledFacetRegistry,
  resolveNodeStencil,
  VISUAL_STENCIL_KEY,
} from '@kamiazya/whiteboard-plugin-visual'
import type { EditorCommand } from './commands.js'

type Node = SpatialCanvas['nodes'][number]

export function isStencilWrite(key: string): boolean {
  return key === VISUAL_STENCIL_KEY
}

/**
 * The commands for one node, given the stencil record the panel wrote:
 * `{ stencil: id }` dresses it, `undefined` (the None chip) undresses it.
 * A record naming a stencil the registry does not hold writes nothing, the
 * way an unknown id refuses the whole batch on the tool — a box half-dressed
 * claims a distinction it does not draw.
 */
export function stencilWriteCommands(
  node: Node,
  payload: unknown,
  registry: FacetRegistry = bundledFacetRegistry,
): EditorCommand[] {
  if (payload === undefined) return undress(node, registry)
  const id = (payload as { stencil?: unknown } | null)?.stencil
  if (typeof id !== 'string') return []
  const dressed = applyStencil(node, id, registry)
  if (dressed === undefined) return []

  const before = node.facets ?? {}
  const after = dressed.facets ?? {}
  const removed = Object.keys(before).filter((key) => !(key in after))
  return [
    ...removed.map((key) => ({
      kind: 'set-node-facet' as const,
      id: node.id,
      key,
      payload: undefined,
    })),
    ...Object.entries(after).map(([key, value]) => ({
      kind: 'set-node-facet' as const,
      id: node.id,
      key,
      payload: value,
    })),
    ...(dressed.color === node.color
      ? []
      : [{ kind: 'set-node-color' as const, id: node.id, color: dressed.color }]),
  ]
}

/**
 * The inverse of dressing: the record goes, and so does exactly what the
 * worn stencil wrote — its facets, and its colour when it spent one. What
 * the stencil never wrote (a hand-set colour, another plugin's facet) stays,
 * which is the same line `applyStencil` draws when it re-dresses.
 */
function undress(node: Node, registry: FacetRegistry): EditorCommand[] {
  const worn = resolveNodeStencil(node, registry)
  const asset = worn === undefined ? undefined : registry.stencilAsset(worn)
  const keys = [VISUAL_STENCIL_KEY, ...Object.keys(asset?.facets ?? {})].filter(
    (key) => node.facets !== undefined && key in node.facets,
  )
  return [
    ...keys.map((key) => ({
      kind: 'set-node-facet' as const,
      id: node.id,
      key,
      payload: undefined,
    })),
    ...(asset?.color !== undefined && node.color === asset.color
      ? [{ kind: 'set-node-color' as const, id: node.id, color: undefined }]
      : []),
  ]
}
