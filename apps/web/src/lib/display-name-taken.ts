import { isSiblingDisplayNameTaken } from '@kamiazya/whiteboard-model'
import { DisplayNameTakenError } from '@kamiazya/whiteboard-ports'

/**
 * The sentence a duplicate name is refused with — the keeper's own, built
 * from the same error both keepers throw, so a refusal seen here before
 * sending reads exactly like one a keeper answers after.
 */
export function displayNameTakenMessage(
  kind: 'folder' | 'document',
  path: string,
  name: string,
): string {
  return new DisplayNameTakenError(kind, path, name).message
}

/**
 * Why a document at `path` cannot be called `name`, or null: another document
 * directly in the same folder already shows it. `documentId` is the document
 * itself when it already exists, left out so keeping its own name is never a
 * duplicate. Folders are another kind and are not compared.
 */
function documentNameTaken(
  documents: readonly {
    readonly documentId: string
    readonly path: string
    readonly name?: string | undefined
  }[],
  target: { readonly path: string; readonly name: string; readonly documentId?: string },
): string | null {
  const others = documents.filter((each) => each.documentId !== target.documentId)
  return isSiblingDisplayNameTaken(others, target)
    ? displayNameTakenMessage('document', target.path, target.name)
    : null
}

/**
 * `documentNameTaken` as a guard in front of a write: throws the refusal, so
 * a create or a rename reports it through the same path the keeper's own
 * refusal of the same name takes. No name is never a duplicate.
 */
export function refuseTakenDocumentName(
  documents: Parameters<typeof documentNameTaken>[0],
  target: {
    readonly path: string
    readonly name: string | undefined
    readonly documentId?: string
  },
): void {
  if (target.name === undefined) return
  const refusal = documentNameTaken(documents, { ...target, name: target.name })
  if (refusal !== null) throw new Error(refusal)
}
