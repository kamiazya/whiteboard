/**
 * Node facets a property test can hang on a generated node, ENUMERATED FROM
 * THE REGISTRY rather than listed here.
 *
 * A layout is a fold over a node's facets, and the recurring defect is a
 * second entry point that folds over fewer of them than the committed
 * layout does — silhouettes resolved for the drop and not for the frame
 * being dragged through. A generator that names its facets cannot catch the
 * next one, because the facet is registered after the test is written. This
 * one asks the registry what exists and `facetPayloadSamples` what each
 * facet accepts, so a facet added to any plugin arrives in every property
 * built on it with no test edit at all.
 *
 * `nodeFacetCoverage` is the other half and the reason this is not merely
 * convenient: a facet whose schema the sample deriver cannot express
 * produces nothing, which would widen the generator's domain by zero while
 * still reading as covered. It reports that, so a property can fail naming
 * the facet instead of passing over it.
 */

import { type FacetRegistry, facetPayloadSamples } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialNode } from '@kamiazya/whiteboard-model'
import { fc } from './fast-check.js'

/** One registered node-target facet and the payloads this build can write for it. */
export interface NodeFacetCoverage {
  readonly key: string
  readonly samples: readonly unknown[]
}

/**
 * Every node-target facet the registry holds, with its derived payloads —
 * in registration order, so a failure names facets in the order a reader
 * finds them in the plugin.
 */
export function nodeFacetCoverage(registry: FacetRegistry): readonly NodeFacetCoverage[] {
  return registry.plugins.flatMap((plugin) =>
    plugin.facets
      .filter((facet) => facet.targets.includes('node'))
      .map((facet) => ({
        key: `${plugin.id}.${facet.name}/${facet.version}`,
        samples: facetPayloadSamples(facet),
      })),
  )
}

/**
 * A node's `x-whiteboard` facets bucket: each registered node facet
 * independently absent or carrying one of its payloads.
 *
 * Absence is drawn as often as any single payload because it is the case
 * every existing consumer already handles — the property needs the mixed
 * canvas (some nodes shaped, some not), not a canvas where every node
 * wears everything.
 */
export function nodeFacetsArb(
  registry: FacetRegistry,
): fc.Arbitrary<SpatialNode['x-whiteboard'] | undefined> {
  const covered = nodeFacetCoverage(registry).filter((entry) => entry.samples.length > 0)
  if (covered.length === 0) return fc.constant(undefined)
  const perFacet = covered.map((entry) =>
    fc
      .option(fc.constantFrom(...entry.samples), { nil: undefined })
      .map((payload) => (payload === undefined ? undefined : ([entry.key, payload] as const))),
  )
  return fc.tuple(...perFacet).map((entries) => {
    const facets = Object.fromEntries(entries.filter((entry) => entry !== undefined))
    return Object.keys(facets).length === 0 ? undefined : { facets }
  })
}
