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

import { documentMatchesSearch } from '../workspace-top-bar/document-list.js'
import { compareDocumentEntries, type WorkspaceDocumentEntry } from './document-entry.js'

export function searchDocuments<T extends WorkspaceDocumentEntry>(
  documents: readonly T[],
  query: string,
): readonly T[] {
  if (query.trim() === '') return []
  return documents
    .filter((entry) => documentMatchesSearch(query, entry))
    .sort(compareDocumentEntries)
}
