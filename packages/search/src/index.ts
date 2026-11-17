import {
  type FoundSpan,
  type LinkEntry,
  type LinkLabelSet,
  type SearchableContent,
  type SearchableDocument,
  type SearchHit,
  type SearchOptions,
  searchCore,
} from './core.js'

// Every function below answers through the core a realm installed
// (`installSearchCore`): lexical search has no TypeScript implementation, so
// the daemon and the browser rank one corpus the same way because one program
// ranks it.
export {
  type AlsoIndex,
  type FoundSpan,
  isSearchRefusal,
  type LinkLabelSet,
  type SearchableContent,
  type SearchableDocument,
  type SearchCore,
  type SearchHit,
  type SearchOptions,
  installSearchCore,
  searchCoreInstalled,
} from './core.js'

/** What a text is compared as: case folded and Latin accents removed. */
export const foldForSearch = (text: string): string => searchCore('foldForSearch').foldForSearch(text)

/** Where `needle` occurs in `text` once both are folded, as a span of the ORIGINAL text. */
export const findFolded = (text: string, needle: string): FoundSpan | undefined =>
  searchCore('findFolded').findFolded(text, needle)

/** The query tokenizer: latin runs as lowercased words, CJK runs as adjacent bigrams. */
export const tokenize = (text: string): string[] => searchCore('tokenize').tokenize(text)

/** The index tokenizer: as `tokenize`, with every CJK character on its own as well. */
export const tokenizeForIndex = (text: string): string[] =>
  searchCore('tokenizeForIndex').tokenizeForIndex(text)

/** The display names of the named folders a document at `path` sits in, top down. */
export const folderNamesOf = (path: string, names: ReadonlyMap<string, string>): string[] =>
  searchCore('folderNamesOf').folderNamesOf(path, names)

/** The one definition of what text a document contributes to search. */
export const searchableTexts = (content: SearchableContent): string[] =>
  searchCore('searchableTexts').searchableTexts(content)

/** A listing's link labels. The caller releases them when the listing goes. */
export const linkLabels = (entries: Iterable<LinkEntry>): LinkLabelSet =>
  searchCore('linkLabels').linkLabels(entries)

/** A short plain-text excerpt around `[index, index + length)` of `text`. */
export const snippetAround = (
  text: string,
  index: number,
  length: number,
  labels?: LinkLabelSet,
): string => searchCore('snippetAround').snippetAround(text, index, length, labels)

/**
 * The excerpts `query` finds in each document's texts, one list per entry of
 * `documents`: the three texts that match best, quoted.
 */
export const excerpts = (
  query: string,
  documents: readonly (readonly string[])[],
  labels?: LinkLabelSet,
): string[][] => searchCore('excerpts').excerpts(query, documents, labels)

/**
 * BM25 over the documents' token bags, name and path included as text. Scores
 * are relative to THIS corpus: never compare across calls.
 */
export const fullTextSearch = (
  documents: readonly SearchableDocument[],
  query: string,
  options?: SearchOptions,
): SearchHit[] => searchCore('fullTextSearch').fullTextSearch(documents, query, options)
