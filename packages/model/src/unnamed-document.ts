// What an unnamed document reads as, decided once for every keeper and every
// surface: a name a keeper DERIVES from one (a duplicate's) has to start from
// the word people already see for it, or the copy reads like a different
// document from the one they copied.

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
  const last = path.slice(path.lastIndexOf('/') + 1)
  return /^untitled(?:-(?:[2-9]|[1-9]\d+))?$/.test(last)
}

/**
 * What a document is called where nothing narrower applies: its chosen name;
 * unnamed at a generated address, `Untitled`; otherwise its address. Unnamed
 * is spelled by absence, as both keepers' index stores it.
 */
export function documentShownName(entry: {
  readonly name?: string | null | undefined
  readonly path: string
}): string {
  if (entry.name !== null && entry.name !== undefined) return entry.name
  return isGeneratedDocumentPath(entry.path) ? UNTITLED_DOCUMENT_WORD : entry.path
}
