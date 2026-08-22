/**
 * The contribution resolution layer: which facet UI a core surface carries,
 * answered as DATA so no surface ever names a plugin or facet key itself.
 *
 * Ownership is two-level. The POINT (core) owns the closed set of points,
 * the namespace containers and their order, and any per-point caps; the
 * PLUGIN owns only the inside of its own container. Ordering is by plugin
 * ID, never displayName — a display name may be reworded or localized, and
 * deterministic order must not move when it does.
 */

import type { FacetDefinition, FacetRegistry } from './registry.js'

/**
 * The closed set of places facet UI can appear. Adding a point is a core
 * increment, exactly like adding a widget kind — a plugin can neither mint
 * a point nor place itself outside its container. A point exists only once
 * its vessel does: `documentProperties` (the DocumentProperties disclosure)
 * joins together with the surface that consumes it, in the facet editor
 * increment.
 */
export type ContributionPoint = 'contextMenu.node.properties' | 'canvasSettings'

const POINT_TARGET = {
  'contextMenu.node.properties': 'node',
  canvasSettings: 'canvas',
} as const

export interface FacetContribution {
  /** The facet's current storage key, `{namespace}.{name}/v{n}`. */
  readonly key: string
  readonly definition: FacetDefinition
}

export interface NamespaceContributions {
  readonly namespace: string
  /** The plugin's human-facing name — what a container heading shows. */
  readonly displayName: string
  readonly facets: readonly FacetContribution[]
}

/**
 * Derived mechanically from facet targets: a plugin never declares where it
 * appears. Plugins contributing nothing to a point produce no group.
 */
export function resolveFacetContributions(
  registry: FacetRegistry,
  point: ContributionPoint,
): readonly NamespaceContributions[] {
  const target = POINT_TARGET[point]
  return [...registry.plugins]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .flatMap((plugin) => {
      const facets = plugin.facets
        .filter((definition) => definition.targets.includes(target))
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .map((definition) => ({
          key: `${plugin.id}.${definition.name}/${definition.version}`,
          definition,
        }))
      if (facets.length === 0) return []
      return [{ namespace: plugin.id, displayName: plugin.displayName, facets }]
    })
}
