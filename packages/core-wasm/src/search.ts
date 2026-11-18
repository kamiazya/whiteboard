import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { Finalizer } from './font-handles.js'
import { type RefusalCode, SEARCH_OP_CAPS } from './generated/input-caps.js'

// Lexical search over the wasm artifact (`crates/bindings/wasm/src/search`):
// one export, `search_op`, takes `[op, ...args]` as JSON and answers
// `["ok", ...]` or `["refused", code]`. This module is its typed face.
//
// Three kinds of call, by what they need held:
//
// - Text in, answer out (`foldForSearch`, `findFolded`, `snippetAround`, ...):
//   stateless and cheap, safe to call per keystroke.
// - A `LinkLabelSet`: a listing's labels, sent once and named by handle, so a
//   page of excerpts does not resend the listing.
// - A `SearchIndex`: a corpus's token bags, held in the instance. A document is
//   sent once when it changes (`upsert`) and a query sends its string alone.
//   Both handles release explicitly (`release()`) or when collected.
//
// A string is sent well-formed: a lone surrogate becomes U+FFFD, which is one
// UTF-16 unit like the surrogate and is no letter, digit, mark or CJK
// character either, so every offset and token the TypeScript answered stays
// the same; only an echo of the text (a folded string, an excerpt) carries
// U+FFFD where the TypeScript carried the surrogate.

/** The errors this module throws, made by the package entry that owns their classes. */
export interface SearchErrors {
  refused(operation: string, code: RefusalCode, detail?: string): Error
}

/** The glue call this module makes. */
export interface SearchGlue {
  search_op(request: string): string
}

/** A document a corpus holds, as a root names it. */
interface SearchableDocument {
  readonly documentId: string
  readonly path: string
  readonly name?: string
  /** Body / node / label texts, each a separate string so snippets stay per-source. */
  readonly texts: readonly string[]
  /** Display names of the named folders the document sits in (`folderNamesOf`). */
  readonly folders?: readonly string[]
}

/** A document a link can name, by path or by id. */
interface LinkEntry {
  readonly documentId: string
  readonly path: string
  readonly name?: string
}

/**
 * Extra searchable text a caller derives from a document's own content, for
 * indexing only: it answers TEXT, so how a word is cut up stays the core's.
 */
type AlsoIndex = (text: string) => string

/** What one document contributes to an index. */
interface DocumentTerms {
  readonly counts: ReadonlyMap<string, number>
  readonly length: number
}

/** A document's content, as much of it as search needs to see. */
type SearchableContent =
  | { readonly kind: 'markdown'; readonly body: string; readonly description?: string }
  | { readonly kind: 'spatial'; readonly canvas: SpatialCanvas }

/** Where a match sits in the ORIGINAL text, in UTF-16 units. */
interface FoundSpan {
  readonly index: number
  readonly length: number
}

interface SearchHit {
  readonly documentId: string
  /** BM25, relative to the corpus it was asked of: never compare across calls. */
  readonly score: number
  /** Excerpts around the first match per text that contains one. */
  readonly contexts: readonly string[]
}

interface SearchOptions {
  /** Ten when absent. */
  readonly limit?: number
  /** False answers every hit with no contexts. True when absent. */
  readonly excerpts?: boolean
  readonly alsoIndex?: AlsoIndex
  /** What a `[[link]]` in an excerpt shows. */
  readonly linkLabels?: LinkLabelSet
}

/** The default number of hits. */
const DEFAULT_LIMIT = 10

const toWellFormed = (s: string): string =>
  (s as string & { toWellFormed(): string }).toWellFormed()

/**
 * A document id as the index keys it. One that is not well-formed is refused
 * rather than rewritten: U+FFFD in place of a lone surrogate would key two
 * distinct ids alike and answer a hit under an id its caller never named.
 */
function idOf(channel: Channel, op: string, id: string): string {
  if (!(id as string & { isWellFormed(): boolean }).isWellFormed()) {
    throw channel.errors.refused('search_op', 'malformed', op)
  }
  return id
}

const bits = new DataView(new ArrayBuffer(8))

function scoreOf(hex: unknown): number | undefined {
  if (typeof hex !== 'string' || !/^[0-9a-f]{16}$/.test(hex)) return undefined
  bits.setBigUint64(0, BigInt(`0x${hex}`))
  return bits.getFloat64(0)
}

/**
 * The UTF-8 bytes a request is sent as: the cap is on those, and a string of
 * characters past U+007F holds up to three per UTF-16 unit. A lone surrogate
 * crosses as U+FFFD, three bytes, as the encoder writes it.
 */
function utf8Length(text: string): number {
  let bytes = 0
  for (let at = 0; at < text.length; at++) {
    const unit = text.charCodeAt(at)
    if (unit < 0x80) bytes += 1
    else if (unit < 0x800) bytes += 2
    else if (unit >= 0xd800 && unit <= 0xdbff && (text.charCodeAt(at + 1) & 0xfc00) === 0xdc00) {
      bytes += 4
      at++
    } else bytes += 3
  }
  return bytes
}

const isText = (x: unknown): x is string => typeof x === 'string'
const isTexts = (x: unknown): x is string[] => Array.isArray(x) && x.every(isText)

/** One instance's calls: the request, its refusals, and the handles it released. */
class Channel {
  constructor(
    readonly glue: SearchGlue,
    readonly errors: SearchErrors,
  ) {}

  /** The artifact's answer after `ok`, or a thrown `CoreInputRefused`. */
  call(op: string, ...args: unknown[]): unknown[] {
    const request = JSON.stringify([op, ...args])
    // Refused before the artifact is called, on the bytes it would read. A
    // UTF-16 length is never over its UTF-8 one, and never under a third of it,
    // so the count runs only where the length alone cannot decide.
    const max = SEARCH_OP_CAPS.maxBytes
    if (request.length > max || (request.length * 3 > max && utf8Length(request) > max)) {
      throw this.errors.refused('search_op', 'input-too-large', op)
    }
    let answer: unknown
    try {
      answer = JSON.parse(this.glue.search_op(request))
    } catch {
      throw this.errors.refused('search_op', 'malformed', op)
    }
    if (Array.isArray(answer) && answer[0] === 'ok') return answer.slice(1) as unknown[]
    const code = Array.isArray(answer) && answer[0] === 'refused' ? answer[1] : undefined
    throw this.errors.refused('search_op', code === 'input-too-large' ? code : 'malformed', op)
  }

  /** The answer's first element, which must satisfy `is`; otherwise the answer is the artifact's defect. */
  first<T>(op: string, is: (x: unknown) => x is T, ...args: unknown[]): T {
    const [value] = this.call(op, ...args)
    if (!is(value)) throw this.errors.refused('search_op', 'malformed', op)
    return value
  }
}

const isNumber = (x: unknown): x is number => typeof x === 'number'
const isBoolean = (x: unknown): x is boolean => typeof x === 'boolean'

/** A UTF-16 offset or length: a whole, non-negative number a JSON integer carries. */
function unitOf(channel: Channel, op: string, n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw channel.errors.refused('search_op', 'malformed', op)
  return n
}

/** A listing's link labels, held in the instance and named by handle. */
class LinkLabelSet {
  /** @internal */
  readonly handle: number
  /** @internal The instance that minted it: a handle means nothing in another. */
  readonly glue: SearchGlue
  readonly #release: () => void
  readonly #collected: Finalizer
  #released = false

  /** @internal */
  constructor(
    handle: number,
    glue: SearchGlue,
    release: (handle: number) => void,
    collected: Finalizer,
  ) {
    this.handle = handle
    this.glue = glue
    this.#release = () => release(handle)
    this.#collected = collected
    collected.register(this, handle, this)
  }

  /** Forgets the labels; a later use throws `CoreInputRefused`. Safe to call twice. */
  release(): void {
    if (this.#released) return
    this.#released = true
    this.#collected.unregister(this)
    this.#release()
  }
}

/** A corpus's token bags, held in the instance and named by handle. */
class SearchIndex {
  readonly #channel: Channel
  readonly #handle: number
  readonly #collected: Finalizer
  readonly #release: (handle: number) => void
  #released = false

  /** @internal */
  constructor(
    channel: Channel,
    handle: number,
    release: (handle: number) => void,
    collected: Finalizer,
  ) {
    this.#channel = channel
    this.#handle = handle
    this.#release = release
    this.#collected = collected
    collected.register(this, handle, this)
  }

  /**
   * Holds `doc`, replacing what the index held under its id. Answers whether
   * it held one. `alsoIndex` is applied here, to the path, the name and each
   * text, as `documentTerms` applies it; folder names are indexed as written.
   */
  upsert(doc: SearchableDocument, alsoIndex?: AlsoIndex): boolean {
    const expand = expander(alsoIndex)
    const [replaced] = this.#channel.call(
      'index-upsert',
      this.#handle,
      idOf(this.#channel, 'index-upsert', doc.documentId),
      expand(doc.path),
      expand(doc.name ?? ''),
      doc.texts.map(expand),
      doc.folders === undefined ? null : doc.folders.map(toWellFormed),
    )
    if (!isBoolean(replaced))
      throw this.#channel.errors.refused('search_op', 'malformed', 'index-upsert')
    return replaced
  }

  /** Forgets a document; false when the index held none. */
  remove(documentId: string): boolean {
    return this.#channel.first(
      'index-remove',
      isBoolean,
      this.#handle,
      idOf(this.#channel, 'index-remove', documentId),
    )
  }

  /**
   * The best documents for `query` (ten without a `limit`), best first.
   * Throws `CoreInputRefused` for a query past `MAX_QUERY_BYTES`.
   */
  search(query: string, limit?: number): { documentId: string; score: number }[] {
    const [hits] = this.#channel.call(
      'index-query',
      this.#handle,
      toWellFormed(query),
      limit === undefined ? null : unitOf(this.#channel, 'index-query', limit),
    )
    const refuse = () => this.#channel.errors.refused('search_op', 'malformed', 'index-query')
    if (!Array.isArray(hits)) throw refuse()
    return (hits as unknown[]).map((hit) => {
      const [documentId, hex] = Array.isArray(hit) ? (hit as unknown[]) : []
      const score = scoreOf(hex)
      if (!isText(documentId) || score === undefined) throw refuse()
      return { documentId, score }
    })
  }

  /** How many documents it holds and what its bags cost (`TERM_OVERHEAD` charged per term). */
  size(): { documents: number; bytes: number } {
    const [documents, bytes] = this.#channel.call('index-size', this.#handle)
    if (!isNumber(documents) || !isNumber(bytes)) {
      throw this.#channel.errors.refused('search_op', 'malformed', 'index-size')
    }
    return { documents, bytes }
  }

  /** Forgets the corpus; a later use throws `CoreInputRefused`. Safe to call twice. */
  release(): void {
    if (this.#released) return
    this.#released = true
    this.#collected.unregister(this)
    this.#release(this.#handle)
  }
}

function expander(alsoIndex: AlsoIndex | undefined): (text: string) => string {
  return (text) => {
    const extra = alsoIndex === undefined ? '' : alsoIndex(text)
    return toWellFormed(extra === '' ? text : `${text} ${extra}`)
  }
}

/** Lexical search over an initialised core: what `packages/search` answered. */
export interface SearchCore {
  /** The most documents one index holds (`search_op`'s `maxNodes`). */
  readonly indexCapacity: number
  /** `foldForSearch`: what a text is compared as. */
  foldForSearch(text: string): string
  /** `findFolded`: where `needle` occurs in `text`, as a span of the ORIGINAL text. */
  findFolded(text: string, needle: string): FoundSpan | undefined
  /** The query tokenizer: CJK runs as adjacent bigrams. */
  tokenize(text: string): string[]
  /** The index tokenizer: every CJK character on its own as well. */
  tokenizeForIndex(text: string): string[]
  /** The display names of the named folders a document at `path` sits in, top down. */
  folderNamesOf(path: string, names: ReadonlyMap<string, string>): string[]
  /** What text a document contributes to search. */
  searchableTexts(content: SearchableContent): string[]
  /** What one document contributes to an index. */
  documentTerms(
    doc: Pick<SearchableDocument, 'path' | 'name' | 'texts'>,
    alsoIndex?: AlsoIndex,
  ): DocumentTerms
  /** Holds a listing's labels; release it with the listing. */
  linkLabels(entries: Iterable<LinkEntry>): LinkLabelSet
  /** A short plain-text excerpt around `[index, index + length)` of `text`. */
  snippetAround(text: string, index: number, length: number, labels?: LinkLabelSet): string
  /**
   * The excerpts `query` finds in each document's texts, one list per entry of
   * `documents`: the three texts that match best, quoted. The query is cut up
   * once for all of them.
   */
  excerpts(
    query: string,
    documents: readonly (readonly string[])[],
    labels?: LinkLabelSet,
  ): string[][]
  /** An empty corpus. */
  createIndex(): SearchIndex
  /**
   * `fullTextSearch` over documents a caller names in full, through a corpus
   * built and released inside the call. A caller that searches a corpus more
   * than once holds a `SearchIndex` instead and sends each document once.
   */
  fullTextSearch(
    documents: readonly SearchableDocument[],
    query: string,
    options?: SearchOptions,
  ): SearchHit[]
}

type TextCalls = Pick<
  SearchCore,
  'foldForSearch' | 'findFolded' | 'tokenize' | 'tokenizeForIndex' | 'folderNamesOf'
>

function textCalls(channel: Channel): TextCalls {
  const { errors } = channel
  const tokens = (text: string) => {
    const [query, index] = channel.call('tokens', toWellFormed(text))
    if (!isTexts(query) || !isTexts(index)) throw errors.refused('search_op', 'malformed', 'tokens')
    return { query, index }
  }
  return {
    foldForSearch: (text) => channel.first('fold', isText, toWellFormed(text)),
    findFolded(text, needle) {
      const [at] = channel.call('find', toWellFormed(text), toWellFormed(needle))
      if (at === null) return undefined
      const [index, length] = Array.isArray(at) ? (at as unknown[]) : []
      if (!isNumber(index) || !isNumber(length)) {
        throw errors.refused('search_op', 'malformed', 'find')
      }
      return { index, length }
    },
    tokenize: (text) => tokens(text).query,
    tokenizeForIndex: (text) => tokens(text).index,
    folderNamesOf: (path, names) =>
      channel.first(
        'folders',
        isTexts,
        toWellFormed(path),
        [...names].map(([folder, shown]) => [toWellFormed(folder), toWellFormed(shown)]),
      ),
  }
}

const orNull = (text: string | undefined): string | null =>
  text === undefined ? null : toWellFormed(text)

type ContentCalls = Pick<SearchCore, 'searchableTexts' | 'documentTerms'>

function contentCalls(channel: Channel): ContentCalls {
  return {
    searchableTexts(content) {
      if (content.kind === 'markdown') {
        return channel.first(
          'texts',
          isTexts,
          'markdown',
          toWellFormed(content.body),
          orNull(content.description),
        )
      }
      const nodes = content.canvas.nodes.map((node) => [
        orNull(node.label),
        node.resource === undefined
          ? null
          : [
              toWellFormed(node.resource.mimeType),
              orNull(node.resource.content),
              orNull(node.resource.location),
              orNull(node.resource.subpath),
            ],
      ])
      const edges = content.canvas.edges.map((edge) => orNull(edge.label))
      return channel.first('texts', isTexts, 'spatial', nodes, edges)
    },
    documentTerms(doc, alsoIndex) {
      const expand = expander(alsoIndex)
      const [length, counts] = channel.call(
        'terms',
        expand(doc.path),
        expand(doc.name ?? ''),
        doc.texts.map(expand),
      )
      return decodeTerms(length, counts, channel.errors)
    },
  }
}

type ExcerptCalls = Pick<SearchCore, 'linkLabels' | 'snippetAround' | 'excerpts'>

/**
 * A label set's handle, or null for none. Every instance numbers its sets from
 * zero, so a set another instance minted would name this one's labels, or
 * none: it is refused, keyed on the instance so facades over one share sets.
 */
function labelsOf(channel: Channel, op: string, labels: LinkLabelSet | undefined): number | null {
  if (labels === undefined) return null
  if (labels.glue !== channel.glue) throw channel.errors.refused('search_op', 'malformed', op)
  return labels.handle
}

const tooLarge = (err: unknown): boolean =>
  err instanceof Error && 'code' in err && err.code === 'input-too-large'

/**
 * Excerpts for a page of documents in one call. A page can be past the
 * request cap together when no one of its documents is: then each is asked
 * on its own, so a page of long hits keeps its excerpts and only a document
 * past the cap alone has none.
 */
function excerptsPaged(
  channel: Channel,
  query: string,
  documents: readonly (readonly string[])[],
  handle: number | null,
): string[][] {
  const ask = (page: readonly (readonly string[])[]): string[][] => {
    const answered = channel.first(
      'excerpts',
      (x): x is string[][] => Array.isArray(x) && x.every(isTexts),
      toWellFormed(query),
      handle,
      page.map((texts) => texts.map(toWellFormed)),
    )
    if (answered.length !== page.length) {
      throw channel.errors.refused('search_op', 'malformed', 'excerpts')
    }
    return answered
  }
  try {
    return ask(documents)
  } catch (err) {
    if (!tooLarge(err)) throw err
    return documents.map((texts) => {
      try {
        return ask([texts])[0] ?? []
      } catch (one) {
        if (tooLarge(one)) return []
        throw one
      }
    })
  }
}

function excerptCalls(channel: Channel, collected: Finalizer): ExcerptCalls {
  const release = (handle: number) => quietly(channel, 'labels-release', handle)
  return {
    linkLabels(entries) {
      const listed = [...entries].map(({ documentId, path, name }) => [
        toWellFormed(documentId),
        toWellFormed(path),
        orNull(name),
      ])
      return new LinkLabelSet(
        channel.first('labels', isNumber, listed),
        channel.glue,
        release,
        collected,
      )
    },
    snippetAround: (text, index, length, labels) =>
      channel.first(
        'snippet',
        isText,
        toWellFormed(text),
        unitOf(channel, 'snippet', index),
        unitOf(channel, 'snippet', length),
        labelsOf(channel, 'snippet', labels),
      ),
    excerpts: (query, documents, labels) =>
      excerptsPaged(channel, query, documents, labelsOf(channel, 'excerpts', labels)),
  }
}

/** A finalizer must not throw into the runtime's cleanup, and a handle an earlier instance minted is already gone. */
function quietly(channel: Channel, op: string, handle: number): void {
  try {
    channel.call(op, handle)
  } catch {
    /* released with its instance */
  }
}

/** `fullTextSearch` as one call over a corpus built and released inside it. */
function fullTextSearchOver(
  createIndex: () => SearchIndex,
  excerpts: SearchCore['excerpts'],
): SearchCore['fullTextSearch'] {
  return (documents, query, options = {}) => {
    const index = createIndex()
    try {
      for (const doc of documents) index.upsert(doc, options.alsoIndex)
      const hits = index.search(query, options.limit ?? DEFAULT_LIMIT)
      if (hits.length === 0) return []
      const byId = new Map(documents.map((doc) => [doc.documentId, doc]))
      const contexts =
        options.excerpts === false
          ? hits.map(() => [])
          : excerpts(
              query,
              hits.map((hit) => byId.get(hit.documentId)?.texts ?? []),
              options.linkLabels,
            )
      return hits.map((hit, at) => ({ ...hit, contexts: contexts[at] ?? [] }))
    } finally {
      index.release()
    }
  }
}

/** Lexical search over `glue`'s instance. */
export function searchOver(
  glue: SearchGlue,
  errors: SearchErrors,
  finalizer: (release: (handle: number) => void) => Finalizer = (release) =>
    new FinalizationRegistry(release),
): SearchCore {
  const channel = new Channel(glue, errors)
  const labelsCollected = finalizer((handle) => quietly(channel, 'labels-release', handle))
  const release = (handle: number) => quietly(channel, 'index-release', handle)
  const indexesCollected = finalizer(release)
  const createIndex = () =>
    new SearchIndex(channel, channel.first('index-new', isNumber), release, indexesCollected)
  const excerpts = excerptCalls(channel, labelsCollected)
  return {
    ...textCalls(channel),
    ...contentCalls(channel),
    ...excerpts,
    indexCapacity: SEARCH_OP_CAPS.maxNodes,
    createIndex,
    fullTextSearch: fullTextSearchOver(createIndex, excerpts.excerpts),
  }
}

function decodeTerms(length: unknown, counts: unknown, errors: SearchErrors): DocumentTerms {
  const refuse = () => errors.refused('search_op', 'malformed', 'terms')
  if (!isNumber(length) || !Array.isArray(counts)) throw refuse()
  const held = new Map<string, number>()
  for (const pair of counts as unknown[]) {
    const [term, n] = Array.isArray(pair) ? (pair as unknown[]) : []
    if (!isText(term) || !isNumber(n)) throw refuse()
    held.set(term, n)
  }
  return { counts: held, length }
}
