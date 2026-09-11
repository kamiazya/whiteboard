/**
 * A node's or a canvas's `x-whiteboard` facets bucket for a property test,
 * ENUMERATED FROM THE REGISTRY rather than listed here.
 *
 * A layout is a fold over a node's facets and its canvas's, and the
 * recurring defect is a second entry point that folds over fewer of them
 * than the committed layout does — silhouettes resolved for the drop and not
 * for the frame being dragged through; the canvas's theme resolved for the
 * committed scene and not for the edges re-routed under a drag. A generator
 * that names its facets cannot catch the next one, because the facet is
 * registered after the test is written. facet-engine's `facetsArbitrary`
 * asks the registry what exists and each facet's own schema what it
 * accepts, so a facet added to any plugin arrives in every property built
 * on it with no test edit at all; a schema construct it cannot express
 * throws at construction, naming the path, rather than yielding nothing.
 *
 * This wrapper only shapes the record the way the model stores it: an
 * empty bucket is the ABSENT extension, the case every consumer already
 * handles and the one the mixed canvas needs.
 */

import type { FacetRegistry, FacetTarget } from '@kamiazya/whiteboard-facet-engine'
import { facetsArbitrary } from '@kamiazya/whiteboard-facet-engine/testing'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { fc } from './fast-check.js'

export function facetsArb(
  registry: FacetRegistry,
  target: FacetTarget,
): fc.Arbitrary<SpatialCanvas['facets']> {
  // The bare record, not a `{ facets }` wrapper: since ADR-0035 `facets` is a
  // field of a node, an edge and the canvas alike, so a wrapper would only be
  // unwrapped again at every call site — and a wrapper spread into the field
  // it wraps produces a bucket whose keys fail the facet key grammar, which
  // `.catch(undefined)` then drops in silence.
  return facetsArbitrary(registry, target).map((facets) =>
    Object.keys(facets).length === 0 ? undefined : facets,
  )
}
