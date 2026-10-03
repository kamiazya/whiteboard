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
  defineWorkspaceStencilPlugin,
  type FacetRegistry,
  WORKSPACE_PLUGIN_ID,
} from './registry.js'
import type { StencilAssetInput } from './stencil.js'

/** What a workspace's library holds: stencils by BARE name. */
export type WorkspaceStencils = Readonly<Record<string, StencilAssetInput>>

/** A library stencil the registry could not accept, and why. */
export interface DroppedWorkspaceStencil {
  readonly name: string
  readonly message: string
}

export interface WorkspaceStencilComposition {
  readonly registry: FacetRegistry
  readonly dropped: readonly DroppedWorkspaceStencil[]
}

/**
 * `base` plus this workspace's stencils, or `base` itself when there are
 * none — and, for each stencil the registry refuses, a DROP rather than a
 * failure.
 *
 * **Per stencil, not per library.** A library is content somebody typed, and
 * the registry refuses a stencil whose facet payload its plugin rejects. The
 * deployment's own stencils are loud at build because their author is
 * present; a workspace's are composed on every read, so one bad entry taking
 * the composition down disabled stencils for the whole workspace — the
 * bundled six included — and the discovery tool that would have shown the
 * entry. What was dropped is returned, so the write path can refuse the
 * author with the stencil and the facet named, and a read can carry on.
 *
 * The identity return is not an optimisation detail to be tidied away. A
 * registry is immutable data whose compat chains and asset tables are built
 * once per plugin list, and the overwhelmingly common workspace has no
 * library at all — it must not pay a rebuild for the workspaces that do. A
 * caller memoising on the library document's `contentDigest` still wants
 * this, because "no library" has no digest to key on.
 */
export function composeWorkspaceStencils(
  base: FacetRegistry,
  stencils: WorkspaceStencils,
): WorkspaceStencilComposition {
  // Any library `base` already carries is REPLACED, not appended to.
  // Composing twice is reachable — a re-read after the library document
  // changed — and appending blindly would hand `createFacetRegistry` two
  // `workspace` plugins, which it refuses. Dropping first also makes the
  // empty case mean what it says: no library, whatever was composed before.
  const deployment = base.plugins.filter((plugin) => plugin.id !== WORKSPACE_PLUGIN_ID)
  const entries = Object.entries(stencils)
  if (entries.length === 0) {
    const registry =
      deployment.length === base.plugins.length ? base : createFacetRegistry(deployment)
    return { registry, dropped: [] }
  }
  const whole = tryCompose(deployment, stencils)
  if (whole.ok) return { registry: whole.registry, dropped: [] }

  // The slow path runs only for a library the registry refused, so the
  // common one costs a single build. Each stencil is tried on its own
  // because the registry names only the FIRST bad one.
  const kept: Record<string, StencilAssetInput> = {}
  const dropped: DroppedWorkspaceStencil[] = []
  for (const [name, stencil] of entries) {
    const alone = tryCompose(deployment, { [name]: stencil })
    if (alone.ok) kept[name] = stencil
    else dropped.push({ name, message: alone.message })
  }
  const registry =
    Object.keys(kept).length === 0
      ? createFacetRegistry(deployment)
      : createFacetRegistry([...deployment, defineWorkspaceStencilPlugin(kept)])
  return { registry, dropped }
}

export function withWorkspaceStencils(
  base: FacetRegistry,
  stencils: WorkspaceStencils,
): FacetRegistry {
  return composeWorkspaceStencils(base, stencils).registry
}

function tryCompose(
  deployment: FacetRegistry['plugins'],
  stencils: WorkspaceStencils,
): { ok: true; registry: FacetRegistry } | { ok: false; message: string } {
  try {
    return {
      ok: true,
      registry: createFacetRegistry([...deployment, defineWorkspaceStencilPlugin(stencils)]),
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
