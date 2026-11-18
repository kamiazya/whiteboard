import type { SpatialCanvas } from '@kamiazya/whiteboard-model'

/**
 * Extra searchable text a caller derives from a document's own content, for
 * indexing only. It answers TEXT, not tokens: how 「ロケット」 is cut into
 * bigrams is the core's scheme to own, and a caller returning tokens would be
 * a second place that decides it. A snippet quotes what the document says, so
 * derived text never reaches an excerpt.
 */
type AlsoIndex = (text: string) => string

/** A document a corpus holds, as a root names it. */
export interface SearchableDocument {
  readonly documentId: string
  readonly path: string
  readonly name?: string
  /** Body / node / label texts, each a separate string so snippets stay per-source. */
  readonly texts: readonly string[]
  /**
   * Display names of the named folders the document sits in (`folderNamesOf`).
   * They find the document, but rank it below every document whose own
   * name, path or text matched.
   */
  readonly folders?: readonly string[]
}

/** A document a link can name, by path or by id. */
export interface LinkEntry {
  readonly documentId: string
  readonly path: string
  readonly name?: string
}

/** A document's content, as much of it as search needs to see. */
export type SearchableContent =
  | { readonly kind: 'markdown'; readonly body: string; readonly description?: string }
  | { readonly kind: 'spatial'; readonly canvas: SpatialCanvas }

/** Where a match sits in the ORIGINAL text, in UTF-16 units. */
export interface FoundSpan {
  readonly index: number
  readonly length: number
}

export interface SearchHit {
  readonly documentId: string
  /** BM25, relative to the corpus it was asked of: never compare across calls. */
  readonly score: number
  /** Excerpts around the first match per text that contains one. */
  readonly contexts: readonly string[]
}

export interface SearchOptions {
  /** Ten when absent. */
  readonly limit?: number
  /** False answers every hit with no contexts. True when absent. */
  readonly excerpts?: boolean
  readonly alsoIndex?: AlsoIndex
  /** What a `[[link]]` in an excerpt shows. */
  readonly linkLabels?: LinkLabelSet
}

/**
 * A listing's link labels, held by the core until released (or collected): a
 * link names its target by path or by document id and reads as that document's
 * display name, else its path's last segment.
 */
export interface LinkLabelSet {
  release(): void
}

/**
 * A corpus's token bags, held by the core until released (or collected): a
 * document is sent once when it changes and a query sends its string alone.
 * Scores are the corpus's own, as `fullTextSearch`'s over the same documents.
 */
export interface SearchIndex {
  /** Holds `doc`, replacing what the index held under its id; whether it held one. */
  upsert(doc: SearchableDocument, alsoIndex?: AlsoIndex): boolean
  /** Forgets a document; false when the index held none. */
  remove(documentId: string): boolean
  /** The best documents for `query` (ten without a `limit`), best first. */
  search(query: string, limit?: number): { documentId: string; score: number }[]
  /** Forgets the corpus; a later use is refused. Safe to call twice. */
  release(): void
}

/**
 * Lexical search, as `@kamiazya/whiteboard-core-wasm`'s `core.search` answers
 * it. Declared here, structurally, so this package never imports the shim: a
 * realm's composition root holds both and hands one to the other. Methods are
 * declared with method syntax so the shim's own handle classes satisfy it.
 *
 * Any call may throw the shim's `CoreInputRefused` for an input past a cap;
 * `isSearchRefusal` names it, and each caller answers it with its own
 * degraded answer.
 */
export interface SearchCore {
  /** The most documents one index holds; an upsert past it is refused however much memory is free. */
  readonly indexCapacity: number
  foldForSearch(text: string): string
  findFolded(text: string, needle: string): FoundSpan | undefined
  tokenize(text: string): string[]
  tokenizeForIndex(text: string): string[]
  folderNamesOf(path: string, names: ReadonlyMap<string, string>): string[]
  searchableTexts(content: SearchableContent): string[]
  linkLabels(entries: Iterable<LinkEntry>): LinkLabelSet
  snippetAround(text: string, index: number, length: number, labels?: LinkLabelSet): string
  excerpts(
    query: string,
    documents: readonly (readonly string[])[],
    labels?: LinkLabelSet,
  ): string[][]
  createIndex(): SearchIndex
  fullTextSearch(
    documents: readonly SearchableDocument[],
    query: string,
    options?: SearchOptions,
  ): SearchHit[]
}

/**
 * A search function was called in a realm that never installed the core.
 * There is no other implementation to answer with, so this is a wiring defect
 * of the realm (a root that did not load the artifact before serving), never
 * an input to handle.
 */
class SearchCoreNotInstalled extends Error {
  constructor(fn: string) {
    super(
      `${fn} was called before this realm installed the Rust core; call installSearchCore with a loaded core's search first`,
    )
    this.name = 'SearchCoreNotInstalled'
  }
}

/**
 * The core this realm answers search with, or none. Process-global on purpose:
 * the functions are synchronous exports every caller reaches by import, with
 * no dependency to thread a core through. A realm acquires its wasm instance
 * asynchronously, installs it once, and every later call uses it synchronously.
 */
let installed: SearchCore | undefined

/**
 * Makes `core` answer this realm's search; `undefined` removes it. Answers the
 * core it replaced, so a caller that installs a stand-in for a while can put
 * the real one back.
 */
export function installSearchCore(core: SearchCore | undefined): SearchCore | undefined {
  const previous = installed
  installed = core
  return previous
}

/** Whether this realm has a core to answer with. */
export const searchCoreInstalled = (): boolean => installed !== undefined

/** The installed core, or the wiring defect of having none. */
export function searchCore(fn: string): SearchCore {
  if (installed === undefined) throw new SearchCoreNotInstalled(fn)
  return installed
}

/** Whether `err` is the core declining an input past a cap. */
export const isSearchRefusal = (err: unknown): boolean =>
  err instanceof Error && err.name === 'CoreInputRefused'

/**
 * Whether `err` is search having no core to answer: none was installed, which
 * is a realm whose wasm did not load. A surface that must still draw (a list
 * filtering as someone types) degrades on this as on a refusal; everything
 * that can wait for the load awaits it instead.
 */
export const isSearchUnavailable = (err: unknown): boolean =>
  isSearchRefusal(err) || (err instanceof Error && err.name === 'SearchCoreNotInstalled')

// Every function below answers through the core a realm installed
// (`installSearchCore`): lexical search has no TypeScript implementation, so
// the daemon and the browser rank one corpus the same way because one program
// ranks it.

/** What a text is compared as: case folded and Latin accents removed. */
export const foldForSearch = (text: string): string =>
  searchCore('foldForSearch').foldForSearch(text)

/** Where `needle` occurs in `text` once both are folded, as a span of the ORIGINAL text. */
export const findFolded = (text: string, needle: string): FoundSpan | undefined =>
  searchCore('findFolded').findFolded(text, needle)

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

/** An empty corpus the caller keeps between queries and releases when done. */
export const createIndex = (): SearchIndex => searchCore('createIndex').createIndex()

export const searchIndexCapacity = (): number => searchCore('searchIndexCapacity').indexCapacity

/**
 * BM25 over the documents' token bags, name and path included as text. Scores
 * are relative to THIS corpus: never compare across calls.
 */
export const fullTextSearch = (
  documents: readonly SearchableDocument[],
  query: string,
  options?: SearchOptions,
): SearchHit[] => searchCore('fullTextSearch').fullTextSearch(documents, query, options)
