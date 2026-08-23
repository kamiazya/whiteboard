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
 * joins together with the surface that consumes it.
 *
 * Every point is a STATE surface, and that is the rule rather than a
 * coincidence. An action menu's entries run once and close it; a facet is
 * something you look at and adjust, often several times in a row. Facets
 * were briefly carried by the node context menu and it went wrong in the
 * predictable way: the menu grew a row per domain, and a value sat one tap
 * from Delete. The menu keeps a doorway to the inspector, which is
 * navigation, not a contribution.
 */
export type ContributionPoint = 'inspector.node' | 'canvasSettings'

const POINT_TARGET = {
  'inspector.node': 'node',
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
