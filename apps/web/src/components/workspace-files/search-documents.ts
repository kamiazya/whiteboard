/**
 * Finding a document by name, from anywhere in the workspace.
 *
 * Deliberately not scoped to the open folder. Searching is what someone does
 * when they do NOT know where a document is; a search that only looked where
 * they were standing would answer the one question they could already
 * answer by looking.
 *
 * An empty query answers nothing rather than everything. The caller shows
 * the folder's own contents in that case, and returning the whole workspace
 * here would put that decision in two places.
 */

import { folderNamesOf, foldForSearch } from '@kamiazya/whiteboard-search'
import { compareDocumentEntries, type WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import type { FolderNames } from '../../lib/folder-names.js'

const NO_NAMES: FolderNames = new Map()

/**
 * Whether one document answers a query. Lived beside the editor header's
 * switcher until that switcher was retired; the browser's search is the only
 * caller left, so it lives here now.
 */
function documentMatchesSearch(
  query: string,
  document: {
    readonly path: string
    readonly name?: string | undefined
    readonly tags?: readonly string[] | undefined
    readonly carriedTags?: readonly string[] | undefined
  },
): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  // `#tag` is a FILTER, not a search: it matches only documents carrying
  // exactly that tag — themselves, or one of their boxes or edges (ADR-0040
  // decision 3: a board is found by what its contents carry, which is what
  // the strip counts) — never a path or name that happens to contain the
  // word: clicking a tag chip must select the tag's carriers and nothing
  // else. Exact rather than substring for the same reason: `#q` naming no
  // tag selects nothing, instead of quietly widening to every q-ish tag.
  if (q.startsWith('#')) {
    const wanted = q.slice(1)
    if (wanted === '') return true
    const carries = (tag: string) => tag.toLowerCase() === wanted
    return (document.tags?.some(carries) ?? false) || (document.carriedTags?.some(carries) ?? false)
  }
  // Folded the way the content search folds, so a name answers "cafe" for
  // "Café" here exactly as a body does there.
  const folded = foldForSearch(q)
  const has = (text: string) => foldForSearch(text).includes(folded)
  return (
    has(document.path) ||
    (document.name !== undefined && has(document.name)) ||
    (document.tags?.some(has) ?? false)
  )
}

/**
 * Whether the display name of a folder the document sits in answers the
 * query — what finds a note filed under a folder renamed to "Operations
 * Team", whose address still says something else. Not for a `#tag` filter.
 */
function folderMatchesSearch(query: string, path: string, names: FolderNames): boolean {
  const q = foldForSearch(query.trim())
  if (q === '' || q.startsWith('#')) return false
  return folderNamesOf(path, names).some((name) => foldForSearch(name).includes(q))
}

/**
 * The documents whose own name, path or tags match, then those only a
 * folder's display name matched — being filed under a word says less about
 * a document than carrying it, the order the content search keeps too.
 */
export function searchDocuments<T extends WorkspaceDocumentEntry>(
  documents: readonly T[],
  query: string,
  folderNames: FolderNames = NO_NAMES,
): readonly T[] {
  if (query.trim() === '') return []
  const own = documents.filter((entry) => documentMatchesSearch(query, entry))
  const matched = new Set(own)
  const byFolder = documents.filter(
    (entry) => !matched.has(entry) && folderMatchesSearch(query, entry.path, folderNames),
  )
  return [...own.sort(compareDocumentEntries), ...byFolder.sort(compareDocumentEntries)]
}

/**
 * The content answer, plus the documents that only their NAME or PATH
 * matched.
 *
 * Both halves are real answers to different questions, and the panel shows
 * both: replacing the second with the first would make a row appear and then
 * vanish, which reads as the document being found and unfound — and it
 * happens on the most ordinary input there is, a prefix: word-token search
 * cannot match "roa" against "Roadmap", and bigram search cannot match a
 * single CJK character against a longer name. Whatever the lexical layer
 * produces, a document whose name contains what was typed stays listed.
 *
 * Appended rather than merged by rank: these are the matches the ranked
 * search did NOT produce, so there is no score to interleave them with, and
 * putting an unranked row above ranked ones would claim a relevance nothing
 * measured.
 */
export function withNameMatches<R extends { readonly document: WorkspaceDocumentEntry }>(
  rows: readonly R[],
  documents: readonly WorkspaceDocumentEntry[],
  query: string,
  folderNames: FolderNames = NO_NAMES,
): readonly (R | { document: WorkspaceDocumentEntry })[] {
  const produced = new Set(rows.map((row) => row.document.documentId))
  return [
    ...rows,
    ...searchDocuments(documents, query, folderNames)
      .filter((entry) => !produced.has(entry.documentId))
      .map((document) => ({ document })),
  ]
}
