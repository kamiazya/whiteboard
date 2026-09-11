/**
 * Applying a stencil to a node, and reading back which one it wears
 * ([ADR-0034](../../../docs/contributing/adr/0034-stencil-and-recipe.md)
 * decision 5). Separate from `stencils.ts` because that module holds the
 * bundled SET, which `data.ts` imports in order to register it — so these
 * functions, which need the registry, live on this side of that edge.
 */
import type { FacetRegistry } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { bundledFacetRegistry } from './data.js'

export const VISUAL_STENCIL_KEY = 'visual.stencil/v0'

type Node = SpatialCanvas['nodes'][number]

/**
 * Apply a stencil to a node, answering a NEW node or `undefined` when no
 * such stencil is registered. Total and pure: the node handed in is never
 * mutated, and an unknown id yields nothing rather than a half-dressed box —
 * a caller that cannot tell whether the vocabulary was applied is a caller
 * that will ship a drawing claiming a distinction it does not draw.
 *
 * Two things happen, and both matter (ADR-0034 decision 5):
 *
 * - **Expanded.** The stencil's colour and facet payloads are written onto
 *   the node itself, so the drawing is self-contained: every existing
 *   reader, export path and rasteriser draws it with no knowledge of
 *   stencils, and a document that travels without its library still draws.
 * - **Recorded.** The stencil id is stored under `visual.stencil/v0`. This
 *   is not bookkeeping — an id is a distinction the DOCUMENT states about
 *   its own boxes, so a board dressed by kind reads as carrying its
 *   constructs. Without the record the identical drawing reads as `excess`
 *   (appearance corresponding to nothing declared), and the axis would score
 *   a real improvement as a defect.
 *
 * A previous stencil's facets are REPLACED, not merged. A box wearing one
 * stencil's silhouette and another's colour belongs to neither construct,
 * which is the very shape `excess` names.
 */
export function applyStencil(
  node: Node,
  id: string,
  registry: FacetRegistry = bundledFacetRegistry,
): Node | undefined {
  const stencil = registry.stencilAsset(id)
  if (stencil === undefined) return undefined

  const previous = node['x-whiteboard']?.facets ?? {}
  const previousId = readStencilId(previous, registry)
  const wornBefore =
    previousId === undefined
      ? new Set<string>()
      : new Set(Object.keys(registry.stencilAsset(previousId)?.facets ?? {}))

  const kept = Object.fromEntries(
    Object.entries(previous).filter(([key]) => key !== VISUAL_STENCIL_KEY && !wornBefore.has(key)),
  )

  return {
    ...node,
    ...(stencil.color === undefined ? {} : { color: stencil.color }),
    'x-whiteboard': {
      ...node['x-whiteboard'],
      facets: { ...kept, ...stencil.facets, [VISUAL_STENCIL_KEY]: { stencil: id } },
    },
  } as Node
}

function readStencilId(
  facets: Readonly<Record<string, unknown>> | undefined,
  registry: FacetRegistry,
): string | undefined {
  const stored = facets?.[VISUAL_STENCIL_KEY]
  if (stored === undefined) return undefined
  const resolution = registry.resolveFacetPayload(VISUAL_STENCIL_KEY, stored)
  if (resolution.kind !== 'resolved') return undefined
  const value = resolution.value as { stencil?: unknown }
  return typeof value.stencil === 'string' ? value.stencil : undefined
}

/**
 * The one read path for "which stencil is this box wearing". Answers
 * `undefined` for a node that wears none, and for a record naming a stencil
 * this deployment does not have — the READ side never checks registration
 * (a stored id another deployment registered is data), so the caller that
 * needs the asset asks for it and degrades on absence, exactly as an unknown
 * theme id does.
 */
export function resolveNodeStencil(
  node: Node,
  registry: FacetRegistry = bundledFacetRegistry,
): string | undefined {
  return readStencilId(node['x-whiteboard']?.facets, registry)
}
