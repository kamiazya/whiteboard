/**
 * Finding a workspace's library document: a document at a well-known path
 * whose facets hold what the workspace declares (its stencils, its tags).
 * Each library's own reader decides what those facets mean; what is shared
 * is the lookup, so the "no such document" and "no such workspace" answers
 * cannot differ between libraries.
 */

import { readFacets } from '@kamiazya/whiteboard-loro-adapter'
import type { ExtensionFacets } from '@kamiazya/whiteboard-model'
import { type DocumentEntry, isWorkspaceNotFoundError } from '@kamiazya/whiteboard-ports'
import { loadOrCreateDocument } from '../document-io.js'
import type { ServerDeps } from '../server-deps.js'

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

/**
 * The facets of the document at `path`, or `undefined` when the workspace has
 * none there — which a library reader answers as an empty library.
 */
export async function readWorkspaceLibraryFacets(
  deps: ServerDeps,
  workspaceId: string,
  path: string,
  unknownWorkspace: UnknownWorkspace,
  // A caller that already holds the listing passes it, so one call costs
  // one listing however many things it reads from the workspace.
  listed?: readonly DocumentEntry[],
): Promise<ExtensionFacets | undefined> {
  const entries = listed ?? (await listWorkspaceDocuments(deps, workspaceId, unknownWorkspace))
  const library = entries.find((entry) => entry.path === path)
  if (library === undefined) return undefined
  return readFacets(await loadOrCreateDocument(deps, workspaceId, library.documentId))
}
