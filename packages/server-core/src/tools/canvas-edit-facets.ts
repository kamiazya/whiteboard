/**
 * What a `wb_canvas_edit` op does with a facets bucket it carries: the same
 * registry judgement `wb_facet_set` applies, refused by naming the op.
 */
import type { FacetRegistry, FacetTarget } from '@kamiazya/whiteboard-facet-engine'
import type { ExtensionFacets } from '@kamiazya/whiteboard-model'
import { fail } from './canvas-edit-error.js'
import { FacetWriteRejectedError } from './errors.js'
import { checkedBucket } from './facet-write.js'

/**
 * A facets bucket an op carries, judged by the same registry rule
 * `wb_facet_set` applies and stored as the parsed payloads.
 *
 * Refused by naming the facet and the op, so a batch carrying one bad payload
 * stores nothing — including the ops before it. A line is ink, and ink is the
 * EDGE slot of ADR-0013 decision 5: the registry has no fifth target.
 */
function checkedFacets(
  registry: FacetRegistry,
  index: number,
  op: string,
  facets: ExtensionFacets | undefined,
  target: FacetTarget,
): ExtensionFacets | undefined {
  if (facets === undefined) return undefined
  try {
    return checkedBucket(registry, facets, target)
  } catch (error) {
    if (error instanceof FacetWriteRejectedError) fail(index, op, error.message)
    throw error
  }
}

/** `value` with its `facets` replaced by the checked bucket, or absent when that is empty. */
export function withCheckedFacets<T extends { facets?: ExtensionFacets | undefined }>(
  registry: FacetRegistry,
  index: number,
  op: string,
  value: T,
  target: FacetTarget,
): T {
  if (value.facets === undefined) return value
  const { facets, ...rest } = value
  const checked = checkedFacets(registry, index, op, facets, target)
  return (checked === undefined ? rest : { ...rest, facets: checked }) as T
}

/**
 * A patch's `facets` REPLACES the stored bucket, so an emptied one must say so
 * explicitly: dropping the key would keep what the element already had.
 */
export function patchWithCheckedFacets<T extends { facets?: ExtensionFacets | undefined }>(
  registry: FacetRegistry,
  index: number,
  op: string,
  patch: T,
  target: FacetTarget,
): T {
  if (patch.facets === undefined) return patch
  return { ...patch, facets: checkedFacets(registry, index, op, patch.facets, target) }
}
