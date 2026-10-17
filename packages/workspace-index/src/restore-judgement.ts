/**
 * Whether a trashed document's bytes may be put back into a workspace record.
 *
 * A trash row and the bytes it names both arrive from outside the keeper: the
 * row is synced data any writer of the record can rewrite, and a promotion
 * carries bytes the other keeper chose. A restore places what they say into
 * the live record without passing the sync-write checks — the trash map is not
 * node meta, so no placement check sees the row change — so it is held to the
 * same bounds here: the text limits `importWithinTextLimits` judges, the
 * document path grammar, the name bound, and readable node meta.
 *
 * Judged on scratch records, before anything touches the live one, so a
 * refusal leaves the workspace as it was. Both keepers restore through
 * `LoroWorkspaceDocumentIndex`, so this is the one place the judgement lives.
 */
import {
  importWithinTextLimits,
  importWorkspaceSubtree,
  readWorkspaceDocuments,
  unreadableWorkspaceNodes,
} from '@kamiazya/whiteboard-loro-adapter'
import { DOCUMENT_NAME_MAX_LENGTH, documentPathSchema } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'

/**
 * How many documents the bytes would place for `documentId` under
 * `parentPath` — the document and any it held — or `null` when they may not
 * be placed at all.
 */
export function restorableTrashDocuments(
  bytes: Uint8Array,
  input: { readonly documentId: string; readonly parentPath: string | undefined },
): number | null {
  // An empty record replays no runs, so this judges what the bytes HOLD — a
  // body or node text past its bound — at the cost of loading a snapshot.
  const { breach } = importWithinTextLimits(new LoroDoc(), bytes)
  if (breach !== null) return null
  // Placed under the row's parent path as the live record would place it, so
  // the paths read back are the ones the restore would create.
  const placed = new LoroDoc()
  const restored = importWorkspaceSubtree(placed, bytes, input.parentPath)
  // Bytes holding some other document — another row's, say — are refused, so
  // a row can only bring back the document it is for.
  if (restored?.documentId !== input.documentId) return null
  if (unreadableWorkspaceNodes(placed).length > 0) return null
  const documents = readWorkspaceDocuments(placed)
  for (const entry of documents) {
    if (!documentPathSchema.safeParse(entry.path).success) return null
    if ((entry.name?.length ?? 0) > DOCUMENT_NAME_MAX_LENGTH) return null
  }
  return documents.length
}
