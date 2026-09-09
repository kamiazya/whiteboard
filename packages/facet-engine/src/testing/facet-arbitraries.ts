/**
 * Facet payloads drawn from the REGISTRY, so a property over "a node with
 * facets" or "a canvas with facets" follows every facet a plugin registers
 * instead of a list someone typed the day the test was written.
 *
 * The recurring defect this serves is a second code path folding over
 * FEWER facets than the first — silhouettes resolved for the drop and not
 * for the frame being dragged; the canvas's theme resolved for the
 * committed scene and not for the edges re-routed under a drag. A
 * generator that names its facets cannot catch the next one, because the
 * facet is registered after the test is written. This one asks the
 * registry what exists and each facet's own schema what it accepts.
 *
 * Every payload is filtered through `validateFacetWrite`, the write-side
 * check itself, so an asset reference to nothing and a refinement the
 * schema walk cannot see are both honoured; and an `assetRefs` field draws
 * the registered ids, never a random string. A facet whose schema has a
 * construct the walk cannot express throws naming the path — the caller's
 * property fails at construction rather than passing over the facet.
 */
import * as fc from 'fast-check'
import type { z } from 'zod'
import type { AssetKind, FacetRegistry, FacetTarget } from '../registry.js'
import { acceptedOrThrow, arbitraryForSchema } from './zod-arbitrary.js'

export interface FacetEntry {
  readonly key: string
  readonly schema: z.ZodTypeAny
  readonly assetRefs: Readonly<Record<string, AssetKind>> | undefined
}

/**
 * Every facet the registry holds for `target`, with its storage key — in
 * registration order, so a failure names facets in the order a reader
 * finds them in the plugin.
 */
export function facetEntries(registry: FacetRegistry, target: FacetTarget): readonly FacetEntry[] {
  return registry.plugins.flatMap((plugin) =>
    plugin.facets
      .filter((facet) => facet.targets.includes(target))
      .map((facet) => ({
        key: `${plugin.id}.${facet.name}/${facet.version}`,
        schema: facet.schema,
        assetRefs: facet.assetRefs,
      })),
  )
}

/** A payload the registry accepts for one facet. */
export function facetPayloadArbitrary(
  registry: FacetRegistry,
  entry: FacetEntry,
): fc.Arbitrary<unknown> {
  const refs = new Map<string, fc.Arbitrary<unknown>>()
  for (const [field, kind] of Object.entries(entry.assetRefs ?? {})) {
    const ids = registry.assetIds(kind)
    if (ids.length === 0) {
      throw new Error(`facet-arbitrary: no registered "${kind}" asset for ${entry.key}.${field}`)
    }
    // The walker roots every path at `$`, and an asset reference is a
    // top-level field of the facet's payload.
    refs.set(`$.${field}`, fc.constantFrom(...ids))
  }
  return acceptedOrThrow(
    arbitraryForSchema(entry.schema, { override: (path) => refs.get(path) }),
    (payload) => {
      const result = registry.validateFacetWrite(entry.key, payload)
      return result.ok ? undefined : result.message
    },
    entry.key,
  )
}

/**
 * A `facets` record over the registry's `target` facets — the shape a
 * canvas envelope, a node extension or an OKF frontmatter holds — each
 * facet independently absent or carrying a payload the registry accepts.
 *
 * Absence is a first-class draw, not a rare one: it is the case every
 * existing consumer already handles, and what a property needs is the
 * MIXED canvas — some nodes shaped, some not — rather than one where every
 * node wears everything. Facets are drawn independently for the same
 * reason, so a canvas reaches combinations no single fixture would.
 */
export function facetsArbitrary(
  registry: FacetRegistry,
  target: FacetTarget,
): fc.Arbitrary<Readonly<Record<string, unknown>>> {
  const perFacet = facetEntries(registry, target).map((entry) =>
    fc
      .option(facetPayloadArbitrary(registry, entry), { nil: undefined, freq: 2 })
      .map((payload) => (payload === undefined ? undefined : ([entry.key, payload] as const))),
  )
  return fc
    .tuple(...perFacet)
    .map((entries) => Object.fromEntries(entries.filter((entry) => entry !== undefined)))
}
