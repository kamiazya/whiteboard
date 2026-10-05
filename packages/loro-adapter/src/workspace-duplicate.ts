import type { LoroDoc } from 'loro-crdt'
import {
  createWorkspaceDocumentAtPath,
  projectWorkspaceDocument,
  resolveWorkspaceDocumentById,
  type WorkspaceDocumentEntry,
  writeWorkspaceDocumentContent,
} from './workspace-tree.js'

/**
 * A new document at `path`, named `name`, holding a copy of the source's
 * content — as one change to the workspace record, so a keeper saves it once
 * and no reader ever sees the copy empty or unnamed.
 *
 * A VALUE copy of the content, through the projection every reader of a
 * document already uses: the copy shares no history and no container with
 * the source, and a stored plane the source still carries stays behind, as it
 * does for every projection. The source's kind travels; its id, path, pin and
 * timestamps do not.
 *
 * The name is written as CHOSEN: the copy is named by the verb on the
 * person's behalf, the way a name typed at create is.
 *
 * `null`, with nothing written, when the source is not in the tree or a
 * document already owns `path`; the caller derives a free path first.
 */
export function duplicateWorkspaceDocument(
  doc: LoroDoc,
  input: { sourceDocumentId: string; documentId: string; path: string; name: string },
): WorkspaceDocumentEntry | null {
  const source = resolveWorkspaceDocumentById(doc, input.sourceDocumentId)
  const content = projectWorkspaceDocument(doc, input.sourceDocumentId)
  if (source === null || content === null) return null
  const created = createWorkspaceDocumentAtPath(doc, {
    path: input.path,
    documentId: input.documentId,
    kind: source.kind,
    name: input.name,
  })
  if (created === null) return null
  writeWorkspaceDocumentContent(doc, input.documentId, content)
  return resolveWorkspaceDocumentById(doc, input.documentId)
}
