/**
 * Applying a STENCIL to a node a `wb_canvas_edit` batch is about to keep
 * ([ADR-0034](../../../../docs/contributing/adr/0034-stencil-and-recipe.md)).
 *
 * Its own module because `canvas-edit.ts` is 300 lines past the repo's
 * file-size budget and the budget is shrink-only: a grandfathered ceiling
 * raised to fit a new feature is the ceiling meaning nothing. Nothing here
 * closes over the batch, so there was nothing to keep inside it.
 */

import type { FacetRegistry } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialNode } from '@kamiazya/whiteboard-model'
import { applyStencil } from '@kamiazya/whiteboard-plugin-visual'
import { CanvasEditError } from './canvas-edit-error.js'

/**
 * An unknown id fails the WHOLE batch rather than landing the box
 * undressed. A caller that cannot tell whether the vocabulary was applied
 * ships a drawing claiming a distinction it does not draw — and the refusal
 * lists what IS registered, because "unknown stencil" alone sends an author
 * to documentation for a list this process is already holding.
 */
export function dressWithStencil(
  index: number,
  opName: string,
  node: SpatialNode,
  stencil: string | undefined,
  /**
   * The colour the caller named in THIS op, if any — `node.color` on a
   * `node.add` draft, `patch.color` on a `node.patch`.
   *
   * Taken as a parameter rather than read off `node`, which is the bug this
   * signature exists to prevent: on a patch the node already HAS a colour,
   * from an earlier stencil or from an earlier edit, and reading it there
   * made every re-dress keep the old colour while taking the new
   * silhouette. The rule is "what the caller said in this op wins", not
   * "whatever the box happens to be".
   */
  requestedColor: string | undefined,
  /**
   * The DEPLOYMENT's registry, which is the whole point of ADR-0034
   * decision 4: a vocabulary this repo did not ship still has to apply.
   * `facet-set` and `facet-list` already read `deps.facetRegistry`; this
   * path did not, so a stencil `wb_facet_list` reported was refused here.
   */
  registry: FacetRegistry,
): SpatialNode {
  if (stencil === undefined) return node
  const applied = applyStencil(node, stencil, registry)
  if (applied === undefined) {
    throw new CanvasEditError(
      index,
      opName,
      // The refusal is one of the two runtime discovery paths the tool
      // schema deliberately gave up (see `STENCIL_FIELD`), so it lists the
      // DEPLOYMENT's ids — the bundled list would teach the wrong set.
      `no stencil "${stencil}" is registered — registered: ${registry.assetIds('stencils').join(', ')}`,
    )
  }
  return requestedColor === undefined ? applied : { ...applied, color: requestedColor }
}
