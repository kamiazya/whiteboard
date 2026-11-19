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

import { parentOfPath } from '@kamiazya/whiteboard-model'
import { folderNamesOf, foldForSearch, isSearchUnavailable } from '@kamiazya/whiteboard-search'
import { compareDocumentEntries, type WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import type { FolderNames } from '../../lib/folder-names.js'
import { isCoreTrap } from '../../lib/spatial/core-trap.js'

const NO_NAMES: FolderNames = new Map()

/**
 * `answer`, or `degraded` when search has no core to answer (the wasm did not
 * load) declines the input past a cap, or trapped its instance
 * (reset: the next call is answered). This list filters as someone types
 * and must draw whatever happens, so it falls back to plain text rather than
 * failing a render.
 */
function orDegraded<T>(degraded: T, answer: () => T): T {
  try {
    return answer()
  } catch (err) {
    if (isSearchUnavailable(err) || isCoreTrap(err)) return degraded
    throw err
  }
}

/** What a text is compared as: folded by the core, lower-cased without it. */
const comparable = (text: string): string =>
  orDegraded(text.toLowerCase(), () => foldForSearch(text))

/**
 * Each text as it is compared, folded in ONE core call: this list filters
 * every entry on every keystroke, and a call per text is a JSON request each.
 * Folding is per character and a line break survives it, so the texts joined by
 * one fold apart as the texts folded one by one (`search-documents.test.ts`
 * holds that); a text holding a line break itself is folded alone.
 */
function foldAll(texts: Iterable<string>): ReadonlyMap<string, string> {
  const folded = new Map<string, string>()
  const joinable = [...new Set(texts)].filter((text) => !text.includes('\n'))
  const apart = orDegraded(undefined, () => foldForSearch(joinable.join('\n')).split('\n'))
  if (apart !== undefined && apart.length === joinable.length) {
    joinable.forEach((text, at) => {
      folded.set(text, apart[at] ?? '')
    })
  }
  return folded
}

type Searchable = {
  readonly path: string
  readonly name?: string | undefined
  readonly tags?: readonly string[] | undefined
  readonly carriedTags?: readonly string[] | undefined
}

/**
 * Whether one document answers a query, already read as `q` (trimmed and
 * lower-cased) and its fold. Lived beside the editor header's switcher until
 * that switcher was retired; the browser's search is the only caller left, so
 * it lives here now.
 */
function documentMatchesSearch(
  q: string,
  folded: string,
  foldOf: (text: string) => string,
  document: Searchable,
): boolean {
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
  const has = (text: string) => foldOf(text).includes(folded)
  return (
    has(document.path) ||
    (document.name !== undefined && has(document.name)) ||
    (document.tags?.some(has) ?? false)
  )
}

/**
 * The documents whose own name, path or tags match, then those only a
 * folder's display name matched — being filed under a word says less about
 * a document than carrying it, the order the content search keeps too.
 *
 * A folder's display name answers a query for a note filed under a folder
 * renamed to "Operations Team", whose address still says something else; not
 * for a `#tag` filter. The names a path sits under are the same for every path
 * in one folder, so they are asked once per folder.
 */
export function searchDocuments<T extends WorkspaceDocumentEntry>(
  documents: readonly T[],
  query: string,
  folderNames: FolderNames = NO_NAMES,
): readonly T[] {
  if (query.trim() === '') return []
  const q = query.trim().toLowerCase()
  const texts = documents.flatMap((entry) => [
    entry.path,
    ...(entry.name === undefined ? [] : [entry.name]),
    ...(entry.tags ?? []),
  ])
  const foldedTexts = foldAll(texts)
  const foldOf = (text: string) => foldedTexts.get(text) ?? comparable(text)
  const folded = comparable(q)
  const own = documents.filter((entry) => documentMatchesSearch(q, folded, foldOf, entry))
  const matched = new Set(own)
  const folderQuery = comparable(query.trim())
  const inFolder = new Map<string, boolean>()
  const folderMatches = (path: string): boolean => {
    const folder = parentOfPath(path)
    let found = inFolder.get(folder)
    if (found === undefined) {
      found = orDegraded([], () => folderNamesOf(path, folderNames)).some((name) =>
        comparable(name).includes(folderQuery),
      )
      inFolder.set(folder, found)
    }
    return found
  }
  const byFolder =
    folderQuery === '' || folderQuery.startsWith('#')
      ? []
      : documents.filter((entry) => !matched.has(entry) && folderMatches(entry.path))
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
