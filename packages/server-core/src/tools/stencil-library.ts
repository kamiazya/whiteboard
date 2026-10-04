/**
 * Finding a WORKSPACE's stencil library and composing it into the registry
 * a tool resolves stencils through
 * ([ADR-0034](../../../../docs/contributing/adr/0034-stencil-and-recipe.md)
 * decision 4; the authoring format was settled on 2026-09-11).
 *
 * Two scopes meet here and neither becomes the other. `deps.facetRegistry`
 * is the DEPLOYMENT's — chosen once per composition root, because ADR-0013
 * decision 3 fixes facet schemas at distribution time. A library is the
 * workspace's own CONTENT, so it is read per workspace, from a document,
 * and composed on top.
 */
import {
  composeWorkspaceStencils,
  type FacetRegistry,
  type WorkspaceStencils,
} from '@kamiazya/whiteboard-facet-engine'
import {
  readStencilLibrary,
  STENCIL_LIBRARY_PATH,
  VISUAL_STENCILS_KEY,
} from '@kamiazya/whiteboard-plugin-visual'
import type { DocumentEntry } from '@kamiazya/whiteboard-ports'
import type { ServerDeps } from '../server-deps.js'
import { FacetWriteRejectedError } from './errors.js'
import { readWorkspaceLibraryFacets, type UnknownWorkspace } from './workspace-library-document.js'

/**
 * The registry this workspace's stencils resolve through: the deployment's,
 * plus whatever its library document declares.
 *
 * Answers the base registry unchanged when there is no library — which is
 * the overwhelmingly common workspace, and `withWorkspaceStencils` returns
 * the same instance rather than rebuilding one for nothing.
 *
 * A malformed library degrades rather than throwing: a drawing must stay
 * readable when a document elsewhere in the workspace is wrong. It degrades
 * PER STENCIL — one the registry refuses is left out and the rest, the
 * deployment's included, stay usable — and the write path is where a bad
 * library is refused with its author present (`refuseUnusableStencilLibrary`).
 */
export async function workspaceFacetRegistry(
  deps: ServerDeps,
  workspaceId: string,
  unknownWorkspace: UnknownWorkspace,
  // A caller that already holds the listing passes it, so one call costs
  // one listing however many things it reads from the workspace.
  listed?: readonly DocumentEntry[],
): Promise<FacetRegistry> {
  return composeWorkspaceStencils(
    deps.facetRegistry,
    await workspaceStencilLibrary(deps, workspaceId, unknownWorkspace, listed),
  ).registry
}

/**
 * Refuses a write of the stencil library whose stencils the registry would
 * not accept, naming the stencil and the facet key.
 *
 * The facet's own schema checks a library's SHAPE; whether a stencil's facet
 * payloads satisfy the plugins that own them is known only once the library
 * is composed with the deployment's registry. Composing the candidate here
 * is what makes "a bad library is refused at the write" true, instead of the
 * write storing it and every later read dropping it unseen.
 */
export function refuseUnusableStencilLibrary(
  deps: ServerDeps,
  sets: Record<string, unknown>,
): void {
  const candidate = sets[VISUAL_STENCILS_KEY]
  if (candidate === undefined) return
  const { dropped } = composeWorkspaceStencils(
    deps.facetRegistry,
    readStencilLibrary({ [VISUAL_STENCILS_KEY]: candidate }),
  )
  if (dropped.length === 0) return
  throw new FacetWriteRejectedError(
    VISUAL_STENCILS_KEY,
    dropped.map(({ name, message }) => `stencil "${name}": ${message}`).join('; '),
  )
}

/**
 * What the library document declares, or `{}` — the value
 * `workspaceFacetRegistry` composes and a client composes for itself, so
 * the editor and the tools read one definition of "this workspace's
 * stencils".
 */
export async function workspaceStencilLibrary(
  deps: ServerDeps,
  workspaceId: string,
  unknownWorkspace: UnknownWorkspace,
  listed?: readonly DocumentEntry[],
): Promise<WorkspaceStencils> {
  return readStencilLibrary(
    await readWorkspaceLibraryFacets(
      deps,
      workspaceId,
      STENCIL_LIBRARY_PATH,
      unknownWorkspace,
      listed,
    ),
  )
}
