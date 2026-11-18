import { emojiSearchText } from '@kamiazya/whiteboard-plugin-visual/emoji/searchable'
import type { ContentFacts, ContentFactsCache } from '@kamiazya/whiteboard-reference-graph'
import {
  createIndex,
  isSearchRefusal,
  type SearchableDocument,
  type SearchIndex,
} from '@kamiazya/whiteboard-search'

interface HeldDocument {
  /** The facts object this was built from; `undefined` for facts the cache keeps no stamp for. */
  facts: ContentFacts | undefined
  path: string
  name: string | undefined
  folders: string
}

interface HeldWorkspace {
  readonly facts: WeakRef<ContentFactsCache>
  readonly workspaceId: string
  readonly index: SearchIndex
  readonly documents: Map<string, HeldDocument>
}

/**
 * How many workspaces keep an index at once, across the whole process: the
 * core holds a bounded number of them (16), counting ones nothing refers to
 * until they are collected, and a transient corpus (`fullTextSearch`) needs a
 * slot too. Released here when evicted rather than left to collection, the
 * least recently asked first.
 */
const MAX_HELD_WORKSPACES = 8

/** Most recently asked last. */
const held: HeldWorkspace[] = []

/**
 * Each document's search terms, kept in the core between queries and built
 * again only when the document changed: a query costs scoring, not
 * re-tokenizing the workspace.
 *
 * "Changed" is the facts cache's answer, read as the IDENTITY of the facts
 * object it handed out: the cache returns the same object for as long as a
 * document's stamp holds, and a new one when it moves or when it keeps no stamp
 * at all (such a document is indexed again on every read). Reading `stampOf`
 * as the key would race: a concurrent `factsFor` can advance a stamp between
 * this request's read of the texts and its read of the stamp, filing old terms
 * under the new stamp for good. The path, name and folder names are not content
 * and carry no stamp, so they are compared directly: a rename re-indexes that
 * document and nothing else.
 *
 * Answers `undefined` when the core will not hold it.
 *
 * It serves a query over EVERY document the workspace lists: BM25 is relative
 * to its corpus, so a filtered corpus is ranked by `fullTextSearch` instead.
 * Keyed on the facts cache because identity of its facts objects is what
 * validates an entry; terms read against any other would never be hit. The
 * facts cache is referred to weakly, so holding terms never keeps one alive.
 */
export function rankHeld(
  facts: ContentFactsCache,
  workspaceId: string,
  documents: readonly SearchableDocument[],
  content: ReadonlyMap<string, ContentFacts>,
  query: string,
  limit: number,
): { documentId: string; score: number }[] | undefined {
  try {
    const workspace = heldFor(facts, workspaceId)
    sync(workspace, documents, content, (id) => facts.stampOf(workspaceId, id) !== undefined)
    return workspace.index.search(query, limit)
  } catch (err) {
    // The core declined to hold this corpus (it holds a bounded number of
    // indexes, and indexes lingering until collection count): the caller
    // ranks it the stateless way, and the next query builds the index afresh
    // rather than trusting a half-built one.
    forget(facts, workspaceId)
    if (isSearchRefusal(err)) return undefined
    throw err
  }
}

function heldFor(facts: ContentFactsCache, workspaceId: string): HeldWorkspace {
  const at = held.findIndex((w) => w.workspaceId === workspaceId && w.facts.deref() === facts)
  if (at !== -1) {
    const [existing] = held.splice(at, 1) as [HeldWorkspace]
    held.push(existing)
    return existing
  }
  while (held.length >= MAX_HELD_WORKSPACES) held.shift()?.index.release()
  const created = {
    facts: new WeakRef(facts),
    workspaceId,
    index: createIndex(),
    documents: new Map<string, HeldDocument>(),
  }
  held.push(created)
  return created
}

function forget(facts: ContentFactsCache, workspaceId: string): void {
  const at = held.findIndex((w) => w.workspaceId === workspaceId && w.facts.deref() === facts)
  if (at !== -1) held.splice(at, 1)[0]?.index.release()
}

function sync(
  workspace: HeldWorkspace,
  documents: readonly SearchableDocument[],
  content: ReadonlyMap<string, ContentFacts>,
  hasStamp: (documentId: string) => boolean,
): void {
  const wanted = new Set(documents.map((doc) => doc.documentId))
  for (const id of workspace.documents.keys()) {
    if (wanted.has(id)) continue
    workspace.index.remove(id)
    workspace.documents.delete(id)
  }
  for (const doc of documents) {
    const facts = content.get(doc.documentId)
    const folders = doc.folders?.join('\u0000') ?? ''
    const cached = workspace.documents.get(doc.documentId)
    if (
      facts !== undefined &&
      cached?.facts === facts &&
      cached.path === doc.path &&
      cached.name === doc.name &&
      cached.folders === folders
    ) {
      continue
    }
    workspace.index.upsert(doc, emojiSearchText)
    workspace.documents.set(doc.documentId, {
      facts: facts !== undefined && hasStamp(doc.documentId) ? facts : undefined,
      path: doc.path,
      name: doc.name,
      folders,
    })
  }
}
