/**
 * A WORKSPACE's own stencil library, composed into a registry
 * ([ADR-0034](../../../docs/contributing/adr/0034-stencil-and-recipe.md)'s
 * amendment).
 *
 * **Two scopes, and this is the second one.** A plugin set is chosen per
 * SERVER, at distribution time, because ADR-0013 decision 3 fixes facet
 * schemas there and nothing a user writes may define one. A library is the
 * opposite kind of thing: it is CONTENT. It belongs to the workspace holding
 * it, and it syncs, versions, forks and travels with that workspace. So it
 * does not ride the composition root's plugin list, and this module is how
 * the two meet without either becoming the other.
 *
 * **A synthetic plugin, not a second lookup.** A stencil is resolved through
 * `FacetRegistry`, and a library is not a registry — so the resolution is to
 * COMPOSE one. `applyStencil`, the asset picker and `wb_facet_list` all read
 * a registry; a second resolution path beside the first would have to be
 * taught to each of them, and the one nobody remembered to teach would answer
 * a stencil the others could not see.
 *
 * **Why this is not the runtime schema definition ADR-0013 forbids.** A
 * library defines no schema. Every stencil in it is payload under
 * `stencilAssetSchema`, registered at distribution time like any other, and
 * each of its facet payloads is validated against the schema its own plugin
 * registered — by `createFacetRegistry`, on the way in, exactly as a bundled
 * stencil is. The blast radius is a colour string and some already-validated
 * facet values: not code, not a new contract, and nothing the registry has
 * not already agreed to accept. That is the escape valve decision 3 named
 * when it forbade runtime facets — *runtime-variable vocabulary is payload of
 * a facet, not a runtime schema*.
 */
import {
  createFacetRegistry,
  type FacetPlugin,
  type FacetRegistry,
  validatePluginForEngine,
} from './registry.js'
import type { StencilAssetInput } from './stencil.js'

/**
 * The id the synthetic plugin takes, so a library's stencils read
 * `workspace.<name>`. `definePlugin` refuses it to everyone else.
 */
export const WORKSPACE_PLUGIN_ID = 'workspace'

/** What a workspace's library holds: stencils by BARE name. */
export type WorkspaceStencils = Readonly<Record<string, StencilAssetInput>>

/**
 * `base` plus this workspace's stencils, or `base` itself when there are
 * none.
 *
 * The identity return is not an optimisation detail to be tidied away. A
 * registry is immutable data whose compat chains and asset tables are built
 * once per plugin list, and the overwhelmingly common workspace has no
 * library at all — it must not pay a rebuild for the workspaces that do. A
 * caller memoising on the library document's `contentDigest` still wants
 * this, because "no library" has no digest to key on.
 */
export function withWorkspaceStencils(
  base: FacetRegistry,
  stencils: WorkspaceStencils,
): FacetRegistry {
  if (Object.keys(stencils).length === 0) return base
  return createFacetRegistry([...base.plugins, workspacePlugin(stencils)])
}

/**
 * Held to every rule a plugin author's definition is held to, minus the
 * reserved-id one — so a library gets the same refusals, by the same
 * messages, as a plugin that shipped the same mistake.
 */
function workspacePlugin(stencils: WorkspaceStencils): FacetPlugin {
  return validatePluginForEngine({
    id: WORKSPACE_PLUGIN_ID,
    displayName: 'This workspace',
    facets: [],
    assets: { stencils },
  })
}
