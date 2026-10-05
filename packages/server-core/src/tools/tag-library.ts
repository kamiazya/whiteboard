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
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import {
  readTagLibrary,
  TAG_LIBRARY_PATH,
  type TagLibrary,
  tagLibraryObjection,
} from '@kamiazya/whiteboard-plugin-visual'
import type { DocumentEntry } from '@kamiazya/whiteboard-ports'
import type { ServerDeps } from '../server-deps.js'
import { readWorkspaceLibraryFacets, type UnknownWorkspace } from './workspace-library-document.js'

// The constant is plugin-visual's, where the browser keeper reads it too; the
// daemon's barrel and its callers keep naming it from here.
export { TAG_LIBRARY_PATH }

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
  return readTagLibrary(
    await readWorkspaceLibraryFacets(deps, workspaceId, TAG_LIBRARY_PATH, unknownWorkspace, listed),
  )
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

/**
 * The library check for a writer that takes a whole OKF BODY — `wb_workspace_edit`'s
 * `document.set` and the markdown arm of its `document.create`, and the
 * `POST /documents` route behind them. Such a write replaces the document's tags wholesale, so the
 * frontmatter's own list IS the set it would end up carrying and there is no
 * merge to compute (`tagSetsAfter` is what does that on the tag-op path).
 *
 * Without this, a body is the way around `wb_facet_set`'s check: the same
 * forbidden tag, written as frontmatter instead of as a tag op.
 *
 * The listing is taken only when there is a tag to judge, so a tagless body
 * lists the workspace zero times — the same cost rule the tag-op path
 * follows, and pinned the same way.
 */
export async function refuseFrontmatterTags(
  deps: ServerDeps,
  workspaceId: string,
  tags: readonly string[] | undefined,
): Promise<void> {
  if (tags === undefined || tags.length === 0) return
  refuseAgainstLibrary(
    await workspaceTagLibrary(deps, workspaceId, 'deployment'),
    tags,
    'the document',
  )
}
