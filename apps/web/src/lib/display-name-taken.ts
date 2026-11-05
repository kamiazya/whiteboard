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
 * A guard in front of a write: throws the keeper's own refusal when another
 * document directly in the same folder already shows the name, so a create or
 * a rename reports it through the path the keeper's refusal takes. `documentId`
 * is the document itself when it already exists, so keeping its own name is
 * never a duplicate. Folders are another kind and are not compared. No name is
 * never a duplicate.
 */
export function refuseTakenDocumentName(
  documents: readonly {
    readonly documentId: string
    readonly path: string
    readonly name?: string | undefined
  }[],
  target: {
    readonly path: string
    readonly name: string | undefined
    readonly documentId?: string
  },
): void {
  if (target.name === undefined) return
  const others = documents.filter((each) => each.documentId !== target.documentId)
  if (isSiblingDisplayNameTaken(others, { path: target.path, name: target.name })) {
    throw new DisplayNameTakenError('document', target.path, target.name)
  }
}
