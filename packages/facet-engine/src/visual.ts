import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import {
  type edgeRoutingSchema,
  edgeRoutingStyleSchema,
  lineJumpsSchema,
} from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import type { FacetRegistry } from './registry.js'
import { createFacetRegistry, defineFacet, definePlugin } from './registry.js'

/**
 * `visual.edges/v0` — how this canvas's edges are drawn. The facet-shaped
 * successor of the legacy canvas-level `x-whiteboard.edgeRouting`
 * preference; both answer the same question, so this is one facet with two
 * fields, not two facets. `v0`: unstable, payload may still change shape.
 */
export const visualEdgesFacetSchema = z.object({
  routing: edgeRoutingStyleSchema.optional(),
  lineJumps: lineJumpsSchema.optional(),
})

export type VisualEdgesFacet = z.infer<typeof visualEdgesFacetSchema>

export const VISUAL_EDGES_KEY = 'visual.edges/v0'

/**
 * `visual.shape/v0` — what silhouette this node draws. The vocabulary
 * matches canvas-render's outline decomposition (its absent value is the
 * historic rect, deliberately unrepresentable here too — removing the facet
 * IS choosing rect). canvas-render asserts the alignment in its own tests,
 * since this package cannot depend on it.
 */
export const visualShapeFacetSchema = z.object({
  kind: z.enum(['ellipse', 'diamond', 'hexagon', 'parallelogram', 'cylinder']),
})

export type VisualShapeFacet = z.infer<typeof visualShapeFacetSchema>

export const VISUAL_SHAPE_KEY = 'visual.shape/v0'

/**
 * The bundled plugin. Deliberately ordinary (ADR-0013 decision 3): it goes
 * through the same registry, validation and ordering as any deployment's
 * added plugins, and a deployment may disable it.
 */
export const visualPlugin = definePlugin({
  id: 'visual',
  displayName: 'Visual style',
  facets: [
    defineFacet({
      name: 'edges',
      version: 'v0',
      targets: ['canvas'],
      schema: visualEdgesFacetSchema,
    }),
    defineFacet({
      name: 'shape',
      version: 'v0',
      targets: ['node'],
      schema: visualShapeFacetSchema,
    }),
  ],
})

export const bundledPlugins = [visualPlugin]

/**
 * The registry every composition uses unless a deployment configures its
 * own plugin set. A shared instance, not a per-call construction: the
 * registry is immutable data.
 */
export const bundledFacetRegistry = createFacetRegistry(bundledPlugins)

export type EdgeRouting = z.infer<typeof edgeRoutingSchema>

/**
 * The one read path for "how do I route this canvas's edges": the
 * `visual.edges/v0` facet when it resolves, else the legacy
 * `x-whiteboard.edgeRouting` preference. Whole-value precedence, not
 * per-field merge — a facet is one register (replace semantics), so a facet
 * that says only `routing` means "and default line jumps", never "merge
 * with whatever the legacy key held".
 */
export function resolveCanvasEdgeStyle(
  canvas: SpatialCanvas,
  registry: FacetRegistry = bundledFacetRegistry,
): EdgeRouting {
  const extension = canvas['x-whiteboard']
  const stored = extension?.facets?.[VISUAL_EDGES_KEY]
  if (stored !== undefined) {
    const resolution = registry.resolveFacetPayload(VISUAL_EDGES_KEY, stored)
    if (resolution.kind === 'resolved') {
      // Re-parse instead of casting: the registry resolved through this very
      // schema, so this cannot fail — but it keeps the type honest.
      const value = visualEdgesFacetSchema.parse(resolution.value)
      return {
        ...(value.routing === undefined ? {} : { style: value.routing }),
        ...(value.lineJumps === undefined ? {} : { lineJumps: value.lineJumps }),
      }
    }
  }
  return extension?.edgeRouting ?? {}
}

/**
 * The one read path for "what silhouette does this node draw": the
 * `visual.shape/v0` facet when it resolves, else undefined — which every
 * consumer already treats as the historic rect.
 */
export function resolveNodeShape(
  node: SpatialCanvas['nodes'][number],
  registry: FacetRegistry = bundledFacetRegistry,
): VisualShapeFacet['kind'] | undefined {
  const stored = node['x-whiteboard']?.facets?.[VISUAL_SHAPE_KEY]
  if (stored === undefined) return undefined
  const resolution = registry.resolveFacetPayload(VISUAL_SHAPE_KEY, stored)
  if (resolution.kind !== 'resolved') return undefined
  return visualShapeFacetSchema.parse(resolution.value).kind
}
