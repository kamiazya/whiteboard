/**
 * Applying a STENCIL to a node a `wb_canvas_edit` batch is about to keep
 * ([ADR-0034](../../../../docs/contributing/adr/0034-stencil-and-recipe.md)).
 *
 * Its own module because `canvas-edit.ts` is 300 lines past the repo's
 * file-size budget and the budget is shrink-only: a grandfathered ceiling
 * raised to fit a new feature is the ceiling meaning nothing. Nothing here
 * closes over the batch, so there was nothing to keep inside it.
 */

import type { SpatialNode } from '@kamiazya/whiteboard-model'
import { applyStencil, bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
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
): SpatialNode {
  if (stencil === undefined) return node
  const applied = applyStencil(node, stencil)
  if (applied === undefined) {
    throw new CanvasEditError(
      index,
      opName,
      `no stencil "${stencil}" is registered — registered: ${bundledFacetRegistry
        .assetIds('stencils')
        .join(', ')}`,
    )
  }
  // The node's own colour is the more specific statement, so it survives the
  // stencil that would otherwise have set it.
  return node.color === undefined ? applied : { ...applied, color: node.color }
}
