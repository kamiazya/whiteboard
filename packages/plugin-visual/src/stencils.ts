/**
 * The stencil ASSETS the bundled plugin ships ([ADR-0034](../../../docs/contributing/adr/0034-stencil-and-recipe.md)):
 * named appearances a drawing applies to one node. The values are
 * `assets/stencils.json`; why these six, and why they spend silhouette and
 * nothing else, is `assets/README.md`.
 */
import { type StencilAsset, stencilAssetSchema } from '@kamiazya/whiteboard-facet-engine'
import { assetTable } from './asset-table.js'
import stencils from './assets/stencils.json' with { type: 'json' }

/** Keyed by BARE name; the registry composes `visual.<name>`, as it does for themes and icons. */
export const VISUAL_STENCILS: Readonly<Record<string, StencilAsset>> = assetTable(
  'stencil',
  stencils,
  stencilAssetSchema,
)
