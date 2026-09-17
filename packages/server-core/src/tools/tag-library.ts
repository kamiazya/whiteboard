/**
 * Finding a WORKSPACE's tag library and applying what it declares to a tag
 * set about to be written
 * ([ADR-0040](../../../../docs/contributing/adr/0040-scoped-tags.md)
 * decision 5's declared layer; the shape is the stencil library's,
 * `stencil-library.ts`).
 *
 * The library is DATA handed to its readers, not a registry composition: a
 * stencil is an asset the registry resolves, and nothing in the registry
 * reads a tag. So this module answers the library itself, and each reader
 * — the write check below, `wb_facet_list`'s answer, the layout's colour by
 * intent — takes it as a value.
 */
import { readFacets } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import {
  readTagLibrary,
  type TagLibrary,
  tagLibraryObjection,
} from '@kamiazya/whiteboard-plugin-visual'
import type { DocumentEntry } from '@kamiazya/whiteboard-ports'
import type { ServerDeps } from '../server-deps.js'
import { loadOrCreateDocument } from './document-io.js'
import { listWorkspaceDocuments, type UnknownWorkspace } from './stencil-library.js'

/**
 * Where a workspace keeps its tag library: the same kind of CONVENTION as
 * `STENCIL_LIBRARY_PATH`, for the same reason — nothing can ask the index
 * which documents carry a facet, so one well-known path costs one lookup
 * and gives "where do I declare my keys" a single answer. The upgrade is
 * the same too: a default rather than a rule once an index can answer.
 */
export const TAG_LIBRARY_PATH = 'tags'

/**
 * What the document at `tags` declares, or nothing — for a workspace
 * without one, and for a malformed one (a drawing must stay readable when
 * a document elsewhere is wrong; the write path refuses a bad library with
 * its author present). An unknown workspace degrades or refuses as the
 * caller says, exactly as `workspaceFacetRegistry` does.
 */
export async function workspaceTagLibrary(
  deps: ServerDeps,
  workspaceId: string,
  unknownWorkspace: UnknownWorkspace,
  listed?: readonly DocumentEntry[],
): Promise<TagLibrary> {
  const entries = listed ?? (await listWorkspaceDocuments(deps, workspaceId, unknownWorkspace))
  const library = entries.find((entry) => entry.path === TAG_LIBRARY_PATH)
  if (library === undefined) return {}
  const doc = await loadOrCreateDocument(deps, workspaceId, library.documentId)
  return readTagLibrary(readFacets(doc))
}

/** A write the workspace's own library forbids: the message names the key, its rule, and what was written. */
export class TagLibraryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TagLibraryError'
  }
}

const WHERE = `the workspace's tag library (the document at "${TAG_LIBRARY_PATH}")`

/**
 * Refuses `tags` — the WHOLE set a thing would carry after a write — where
 * the library forbids it: a value a key does not admit, or two values
 * under a key declared exclusive. A plain tag and an undeclared key pass;
 * decision 3 keeps a rule nobody declared from refusing a write, and this
 * is the one place a rule is declared. `what` names the thing for the
 * refusal ("the board", "node redis"), since the caller wrote to several.
 */
export function refuseAgainstLibrary(
  library: TagLibrary,
  tags: readonly string[],
  what: string,
): void {
  // The judgement is plugin-visual's, shared with the editor's tag row;
  // only the sentence is this path's — it names the target and where the
  // library lives, which a person typing into a row does not need told.
  const objection = tagLibraryObjection(library, tags)
  if (objection === undefined) return
  if (objection.kind === 'undeclared') {
    throw new TagLibraryError(
      `tag "${objection.tag}" on ${what} is not admitted: ${WHERE} declares ${objection.key} as one of ${objection.admitted.join(', ')}`,
    )
  }
  throw new TagLibraryError(
    `${objection.key} is one value at a time in ${WHERE}, and this write leaves ${what} with ${objection.carried.join(' and ')}`,
  )
}

/**
 * Whether a render of this canvas can read anything from a library: the
 * board, a node or an edge carries a tag. A caller asks this BEFORE
 * loading the library, so an untagged board — the common one — costs no
 * listing and no document read.
 */
export function carriesATag(canvas: SpatialCanvas): boolean {
  return (
    (canvas.tags?.length ?? 0) > 0 ||
    canvas.nodes.some((node) => (node.tags?.length ?? 0) > 0) ||
    canvas.edges.some((edge) => (edge.tags?.length ?? 0) > 0)
  )
}
