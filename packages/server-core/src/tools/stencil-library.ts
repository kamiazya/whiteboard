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
import { type FacetRegistry, withWorkspaceStencils } from '@kamiazya/whiteboard-facet-engine'
import { readFacets } from '@kamiazya/whiteboard-loro-adapter'
import { bundledFacetRegistry, readStencilLibrary } from '@kamiazya/whiteboard-plugin-visual'
import { type DocumentEntry, isWorkspaceNotFoundError } from '@kamiazya/whiteboard-ports'
import type { ServerDeps } from '../server-deps.js'
import { loadOrCreateDocument } from './document-io.js'

/**
 * Where a workspace keeps its library.
 *
 * A CONVENTION, and a deliberate one rather than a placeholder. The document
 * declares itself by carrying `visual.stencils/v0` — that facet is the
 * definition — but nothing can ask the index *which documents carry a
 * facet*, so finding it otherwise means opening every markdown document in
 * the workspace on every write that names a stencil. One well-known path
 * costs one lookup, and gives "where do I put my stencils" a single answer,
 * which is worth more to a model than flexibility is.
 *
 * The upgrade is named: when an index can answer that question, this becomes
 * the DEFAULT rather than the rule, and a workspace may spread its
 * vocabulary over several documents.
 */
export const STENCIL_LIBRARY_PATH = 'stencils'

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
): Promise<FacetRegistry> {
  const base = deps.facetRegistry ?? bundledFacetRegistry
  // A workspace nobody created has no library, and saying so is NOT this
  // function's job — its caller is about to refuse the write by name, with
  // the id the caller's own parameter carries. Rethrowing from here put
  // `WorkspaceNotFoundError` in front of `WorkspaceDocumentNotFoundError`
  // on `wb_facet_set`, which is the refusal-names-the-wrong-thing class
  // ADR-0031 C11 already paid for once.
  const entries = await listOrNone(deps, workspaceId)
  const library = entries.find((entry) => entry.path === STENCIL_LIBRARY_PATH)
  if (library === undefined) return base
  const doc = await loadOrCreateDocument(deps, workspaceId, library.documentId)
  return withWorkspaceStencils(base, readStencilLibrary(readFacets(doc)))
}

async function listOrNone(deps: ServerDeps, workspaceId: string): Promise<DocumentEntry[]> {
  try {
    return await deps.documentIndex.listDocuments({ workspaceId })
  } catch (error) {
    if (isWorkspaceNotFoundError(error)) return []
    throw error
  }
}
