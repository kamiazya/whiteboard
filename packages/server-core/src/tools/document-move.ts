/**
 * Move a document to a new path — same id, same history, same bytes; only
 * the workspace's placement changes — and repoint what other documents
 * wrote to the old path. Documents below the path move with it.
 *
 * An OPERATION (ADR-0018) rather than a port call with a name, because a
 * move is three steps that only one side can take together: the listing the
 * old paths resolved against, the index mutation, and the follow pass over
 * every reference written as an old path. The follow pass needs the listing
 * from BEFORE the mutation, so a surface that reaches the port directly has
 * to remember all three. The HTTP rename route and `wb_workspace_edit`'s
 * `document.move` op are both adapters over this one function, so neither
 * can perform the move and forget the follow.
 *
 * The follow pass REPORTS rather than throws: once the index has moved the
 * document, every reference the pass can repair is one fewer silently broken
 * link, and one it cannot is not a reason to call the move failed. A pass
 * that could not run at all is reported as its error, since the caller is
 * the one with a logger (this package has none) and the one who knows
 * whether a surface should say so.
 */
import { movesForPathChange } from '@kamiazya/whiteboard-codec'
import { documentIdSchema, documentPathSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import {
  type FollowRenameResult,
  followReferencesAfterRename,
} from '../references/follow-rename.js'
import type { ServerDeps } from '../server-deps.js'
import { WorkspaceDocumentNotFoundError } from './document-crud.errors.js'

const wbDocumentMoveInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    documentId: documentIdSchema,
    /** Where the document goes. Documents below its old path move with it. */
    path: documentPathSchema,
  })
  .strict()
export type WbDocumentMoveInput = z.infer<typeof wbDocumentMoveInputSchema>

export interface WbDocumentMoveResult {
  readonly documentId: string
  /** The path the document held before the move. */
  readonly from: string
  /** The path it holds now. */
  readonly path: string
  /**
   * What the follow pass did — or the error that stopped it before it could
   * report, in which case references to the old path may still stand. The
   * move itself stands either way.
   */
  readonly follow: FollowRenameResult | { readonly error: unknown }
}

export async function wbDocumentMove(
  deps: ServerDeps,
  input: WbDocumentMoveInput,
): Promise<WbDocumentMoveResult> {
  const { workspaceId, documentId } = input
  // The listing BEFORE the move is the table the old paths resolved
  // against; the follow pass reads it, and this is the only side of the
  // mutation that can take it.
  const entriesBefore = await deps.documentIndex.listDocuments({ workspaceId })
  const entry = entriesBefore.find((candidate) => candidate.documentId === documentId)
  if (entry === undefined) throw new WorkspaceDocumentNotFoundError(workspaceId, documentId)
  const from = entry.path
  if (from === input.path) {
    return {
      documentId,
      from,
      path: from,
      follow: { updatedDocumentIds: [], failedDocumentIds: [] },
    }
  }
  await deps.documentIndex.moveDocument({ workspaceId, from, to: input.path })
  const moves = movesForPathChange(entriesBefore, from, input.path)
  try {
    const follow = await followReferencesAfterRename(deps, { workspaceId, entriesBefore, moves })
    return { documentId, from, path: input.path, follow }
  } catch (error) {
    return { documentId, from, path: input.path, follow: { error } }
  }
}
