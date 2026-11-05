import { displayNameKey } from '@kamiazya/whiteboard-model'
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
  const parent = parentOf(target.path)
  const key = displayNameKey(target.name)
  // Quoted as the sibling is CALLED, not as it was typed: "plan" beside a
  // document called "Plan" reads as a claim that something is called "plan".
  const holder = documents.find(
    (each) =>
      each.documentId !== target.documentId &&
      parentOf(each.path) === parent &&
      displayNameKey(each.name ?? leafOf(each.path)) === key,
  )
  if (holder !== undefined) {
    throw new DisplayNameTakenError('document', target.path, holder.name ?? leafOf(holder.path))
  }
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

function leafOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}
