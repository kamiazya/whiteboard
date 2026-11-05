import { leafOfPath } from './document-path.js'

// What an unnamed document reads as, decided once for every keeper and every
// surface: `shownName` builds on it, so a name a keeper DERIVES from one (a
// duplicate's) starts from the word people already see for it.

/**
 * The word a document whose address was generated reads as — the title box's
 * word for a document nobody has named yet.
 */
export const UNTITLED_DOCUMENT_WORD = 'Untitled'

/**
 * Whether a path is one the new-document flow chose rather than one a person
 * did: its last segment is `untitled` or `untitled-N` for N >= 2, the shape
 * apps/web's `newDocumentPathIn` produces (a property there holds the two to
 * each other).
 */
export function isGeneratedDocumentPath(path: string): boolean {
  return /^untitled(?:-(?:[2-9]|[1-9]\d+))?$/.test(leafOfPath(path))
}
