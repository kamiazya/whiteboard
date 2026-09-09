/**
 * Facets a property test can hang on a generated node or canvas, ENUMERATED
 * FROM THE REGISTRY rather than listed here.
 *
 * A layout is a fold over a node's facets and its canvas's, and the
 * recurring defect is a second entry point that folds over fewer of them
 * than the committed layout does — silhouettes resolved for the drop and not
 * for the frame being dragged through; the canvas's theme resolved for the
 * committed scene and not for the edges re-routed under a drag. A generator
 * that names its facets cannot catch the next one, because the facet is
 * registered after the test is written. This one asks the registry what
 * exists and `facetPayloadSamples` what each facet accepts, so a facet added
 * to any plugin arrives in every property built on it with no test edit at
 * all.
 *
 * `facetCoverage` is the other half and the reason this is not merely
 * convenient: a facet whose schema the sample deriver cannot express
 * produces nothing, which would widen the generator's domain by zero while
 * still reading as covered. It reports that, so a property can fail naming
 * the facet instead of passing over it.
 */

import {
  type FacetRegistry,
  type FacetTarget,
  facetPayloadSamples,
} from '@kamiazya/whiteboard-facet-engine'
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { fc } from './fast-check.js'

/** One registered facet for the target and the payloads this build can write for it. */
export interface FacetCoverage {
  readonly key: string
  readonly samples: readonly unknown[]
}

/**
 * Every facet the registry holds for the target, with its derived payloads
 * — in registration order, so a failure names facets in the order a reader
 * finds them in the plugin.
 */
export function facetCoverage(
  registry: FacetRegistry,
  target: FacetTarget,
): readonly FacetCoverage[] {
  return registry.plugins.flatMap((plugin) =>
    plugin.facets
      .filter((facet) => facet.targets.includes(target))
      .map((facet) => ({
        key: `${plugin.id}.${facet.name}/${facet.version}`,
        samples: facetPayloadSamples(facet),
      })),
  )
}

/**
 * A node's or a canvas's `x-whiteboard` facets bucket: each registered
 * facet for the target independently absent or carrying one of its payloads.
 *
 * Absence is a first-class draw, not a rare one: it is the case every
 * existing consumer already handles, and what the property needs is the
 * MIXED canvas — some nodes shaped, some not — rather than one where every
 * node wears everything. Facets are drawn independently for the same
 * reason, so a canvas reaches combinations no single fixture would.
 */
export function facetsArb(
  registry: FacetRegistry,
  target: FacetTarget,
): fc.Arbitrary<
  | Pick<NonNullable<SpatialNode['x-whiteboard'] & SpatialCanvas['x-whiteboard']>, 'facets'>
  | undefined
> {
  const covered = facetCoverage(registry, target).filter((entry) => entry.samples.length > 0)
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
