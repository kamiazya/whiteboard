/**
 * Whether a trashed document's bytes may be put back into a workspace record.
 *
 * A trash row and the bytes it names both arrive from outside the keeper: the
 * row is synced data any writer of the record can rewrite, and a promotion
 * carries bytes the other keeper chose. A restore places what they say into
 * the live record without passing the sync-write checks — the trash map is not
 * node meta, so no placement check sees the row change — so it is held to the
 * same bounds here: the text limits `importWithinTextLimits` judges, the
 * path grammar on every node it places, folders included, the name bound,
 * and readable node meta.
 *
 * Judged on scratch records, before anything touches the live one, so a
 * refusal leaves the workspace as it was. Both keepers restore through
 * `LoroWorkspaceDocumentIndex`, so this is the one place the judgement lives.
 */
import {
  importWithinTextLimits,
  importWorkspaceSubtree,
  readWorkspaceNodes,
  unreadableWorkspaceNodes,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  DOCUMENT_NAME_MAX_LENGTH,
  DOCUMENT_PATH_MAX_LENGTH,
  documentPathSchema,
  isSelfOrDescendant,
} from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'

/**
 * How many documents and folders the bytes would place for `documentId`
 * under `parentPath` — the document and everything it held, not counting
 * the folders `parentPath` itself needs — or `null` when they may not be
 * placed at all.
 */
export function restorableTrashDocuments(
  bytes: Uint8Array,
  input: { readonly documentId: string; readonly parentPath: string | undefined },
): { readonly documents: number; readonly folders: number } | null {
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
  return placeableNodes(placed, restored.path)
}

/**
 * The documents and the folders below `top` that `placed` holds, or `null`
 * when any node sits at a path the grammar refuses or a document carries a
 * name past the bound.
 */
function placeableNodes(
  placed: LoroDoc,
  top: string,
): { readonly documents: number; readonly folders: number } | null {
  let documents = 0
  let folders = 0
  for (const node of readWorkspaceNodes(placed)) {
    if (node.path.length > DOCUMENT_PATH_MAX_LENGTH) return null
    if (!documentPathSchema.safeParse(node.path).success) return null
    if (node.type === 'document') {
      if ((node.meta.name?.length ?? 0) > DOCUMENT_NAME_MAX_LENGTH) return null
      documents += 1
    } else if (isSelfOrDescendant(node.path, top)) {
      folders += 1
    }
  }
  return { documents, folders }
}
