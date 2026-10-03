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
  type FacetRegistry,
  type WorkspaceStencils,
  withWorkspaceStencils,
} from '@kamiazya/whiteboard-facet-engine'
import { readFacets } from '@kamiazya/whiteboard-loro-adapter'
import { readStencilLibrary, STENCIL_LIBRARY_PATH } from '@kamiazya/whiteboard-plugin-visual'
import { type DocumentEntry, isWorkspaceNotFoundError } from '@kamiazya/whiteboard-ports'
import type { ServerDeps } from '../server-deps.js'
import { loadOrCreateDocument } from './document-io.js'

/**
 * What to answer when the WORKSPACE itself does not exist. Stated by every
 * caller rather than defaulted, because the two right answers are opposite
 * and which one is right is a property of the caller, not of looking a
 * library up.
 *
 * - `'deployment'` — hand back the deployment's registry as though the
 *   workspace simply had no library. For a caller that is ABOUT to refuse
 *   the same id more specifically: rethrowing from here put
 *   `WorkspaceNotFoundError` in front of `WorkspaceDocumentNotFoundError`
 *   on `wb_facet_set`, which is the refusal-names-the-wrong-thing class
 *   ADR-0031 C11 already paid for once.
 * - `'refuse'` — let `WorkspaceNotFoundError` through. For a caller whose
 *   ANSWER is the workspace's vocabulary and which therefore has no better
 *   refusal to make room for: `wb_facet_list` handed a workspace nobody
 *   made would otherwise report the deployment's stencils, and "the
 *   deployment's six" reads as "this workspace defines none".
 */
export type UnknownWorkspace = 'deployment' | 'refuse'

/**
 * The registry this workspace's stencils resolve through: the deployment's,
 * plus whatever its library document declares.
 *
 * Answers the base registry unchanged when there is no library — which is
 * the overwhelmingly common workspace, and `withWorkspaceStencils` returns
 * the same instance rather than rebuilding one for nothing.
 *
 * A malformed library reads as NO library rather than throwing: a drawing
 * must stay readable when a document elsewhere in the workspace is wrong,
 * and the write path is where a bad library is refused with its author
 * present.
 */
export async function workspaceFacetRegistry(
  deps: ServerDeps,
  workspaceId: string,
  unknownWorkspace: UnknownWorkspace,
  // A caller that already holds the listing passes it, so one call costs
  // one listing however many things it reads from the workspace.
  listed?: readonly DocumentEntry[],
): Promise<FacetRegistry> {
  return withWorkspaceStencils(
    deps.facetRegistry,
    await workspaceStencilLibrary(deps, workspaceId, unknownWorkspace, listed),
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
  const entries = listed ?? (await listWorkspaceDocuments(deps, workspaceId, unknownWorkspace))
  const library = entries.find((entry) => entry.path === STENCIL_LIBRARY_PATH)
  if (library === undefined) return {}
  const doc = await loadOrCreateDocument(deps, workspaceId, library.documentId)
  return readStencilLibrary(readFacets(doc))
}

export async function listWorkspaceDocuments(
  deps: ServerDeps,
  workspaceId: string,
  unknownWorkspace: UnknownWorkspace,
): Promise<DocumentEntry[]> {
  try {
    return await deps.documentIndex.listDocuments({ workspaceId })
  } catch (error) {
    if (unknownWorkspace === 'deployment' && isWorkspaceNotFoundError(error)) return []
    throw error
  }
}
