import {
  type DocumentMove,
  movesForPathChange,
  planReferenceRewrite,
  rewriteCanvasReferences,
  rewriteReferenceTargets,
} from '@kamiazya/whiteboard-codec'
import {
  type DocumentContent,
  readDocumentContent,
  readFacets,
  readMarkdownBody,
  writeMarkdownBody,
  writeSpatialNode,
} from '@kamiazya/whiteboard-loro-adapter'
import { type DocumentKind, type ExtensionFacets, tagsInUse } from '@kamiazya/whiteboard-model'
import {
  readStencilLibrary,
  readTagLibrary,
  STENCIL_LIBRARY_PATH,
  TAG_LIBRARY_PATH,
} from '@kamiazya/whiteboard-plugin-visual'
import {
  type DocumentIndex,
  type DocumentTrash,
  hasDocumentPins,
  hasDocumentTrash,
  WorkspaceNotFoundError,
} from '@kamiazya/whiteboard-ports'
import { splitBearerTags } from '@kamiazya/whiteboard-reference-graph'
import {
  fullTextSearch,
  type SearchableDocument,
  searchableTexts,
} from '@kamiazya/whiteboard-search'
import type { LoroDoc } from 'loro-crdt'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { optional, type WorkspaceDocumentEntry } from './document-entry.js'
import {
  type LoadedMarkdown,
  type WorkspaceFilesSource,
  WorkspaceMissingError,
} from './files-source.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'
import {
  type ContentClock,
  ensureLocalWorkspace,
  idbContentClock,
} from './local-document-summary.js'
import { createTagBearersCache } from './local-files-source-tags.js'
import { LoroStore, type LoroStoreLike } from './loro-store.js'
import {
  type ContentRecord,
  lazyContentRecord,
  loadDocumentContent,
  projectDocumentContent,
} from './workspace-content.js'

/** One document read from the store, with its content already read as the half its kind names. */
interface LoadedDocument {
  documentId: string
  doc: LoroDoc
  content: DocumentContent
}

type ReadableEntry = { documentId: string; path: string; kind?: DocumentKind }

/**
 * One document's current content. A walk passes the workspace record it
 * opened once, so N documents cost one open; a lone read opens its own.
 */
async function loadCurrentDocFrom(
  loro: LoroStoreLike,
  entry: WorkspaceDocumentEntry,
  record?: () => Promise<ContentRecord>,
): Promise<LoroDoc> {
  const doc =
    record === undefined
      ? await loadDocumentContent(entry.documentId, { loro })
      : await projectDocumentContent(await record(), entry.documentId, { loro })
  if (doc === null) throw new Error(`document ${entry.documentId} holds no readable content`)
  return doc
}

/**
 * Every document's content, read and its KIND resolved, skipping what this
 * build cannot read.
 *
 * Four methods here each wrote this walk out — list, load, branch on
 * markdown vs spatial — and the branch is the one place the two stop being
 * interchangeable, so `readDocumentContent` makes it: the document's own
 * recorded kind, the index row's after it, and a canvas for a document that
 * names neither. Skipping rather than failing is the rule everywhere it
 * appears, and for one reason: a rename that repairs nine references of ten
 * beats one that repairs none, and a panel that lists a tagless row beats
 * one that does not open.
 *
 * The workspace record is opened once for the walk, and only if a document is
 * read at all.
 */
async function* readDocumentsFrom(
  loro: LoroStoreLike,
  entries: readonly ReadableEntry[],
): AsyncGenerator<LoadedDocument> {
  const record = lazyContentRecord()
  for (const entry of entries) {
    let doc: LoroDoc
    try {
      doc = await loadCurrentDocFrom(
        loro,
        { documentId: entry.documentId, path: entry.path },
        record,
      )
    } catch {
      continue
    }
    let content: DocumentContent
    try {
      content = readDocumentContent(doc, entry.kind)
    } catch {
      // A canvas this build cannot parse is the same miss as an unreadable
      // document: it carries nothing anyone here can read.
      continue
    }
    yield { documentId: entry.documentId, doc, content }
  }
}

/**
 * Rewrite one document's references in place, answering whether anything
 * changed. The caller saves; this only edits the in-memory doc.
 *
 * A board takes TARGETED writes, never a whole-canvas resync:
 * `readSpatialCanvas` drops records this build cannot parse, so writing the
 * whole canvas back would DELETE them.
 */
function rewriteReferencesIn(
  read: LoadedDocument,
  plan: ReturnType<typeof planReferenceRewrite>,
): boolean {
  const { content } = read
  if (content.kind === 'spatial') {
    const result = rewriteCanvasReferences(content.canvas, plan)
    if (!result.changed) return false
    for (const node of result.changedNodes) writeSpatialNode(read.doc, node)
    return true
  }
  const next = rewriteReferenceTargets(content.body, plan)
  if (next === content.body) return false
  writeMarkdownBody(read.doc, next)
  return true
}

/** A library document's value, or what `read` answers for none: absent, unreadable or malformed. */
async function readLibrary<T>(
  index: DocumentIndex,
  load: (entry: WorkspaceDocumentEntry) => Promise<LoroDoc>,
  path: string,
  read: (facets: ExtensionFacets | undefined) => T,
): Promise<T> {
  const entries = await index.listDocuments({ workspaceId: getBrowserWorkspaceId() })
  const library = entries.find((entry) => entry.path === path)
  if (library === undefined) return read(undefined)
  try {
    return read(readFacets(await load(library)))
  } catch {
    return read(undefined)
  }
}

/**
 * Each pinned document's position in the pinned list, which IS its `pinOrder`
 * — the same reading the daemon source takes of its names route. An index
 * that keeps no pinned list lists everything unpinned.
 */
async function readPinOrder(index: DocumentIndex): Promise<ReadonlyMap<string, number>> {
  if (!hasDocumentPins(index)) return new Map()
  const pinned = await index.listPinnedDocuments({ workspaceId: getBrowserWorkspaceId() })
  return new Map(pinned.map((documentId, position) => [documentId, position]))
}

/**
 * Present exactly when the index keeps a pinned list, so a keeper that cannot
 * pin omits the member rather than offering a pin that cannot persist. The
 * seam names a path; the index pins an id.
 */
function pinMembers(index: DocumentIndex): Pick<WorkspaceFilesSource, 'setPinned'> {
  if (!hasDocumentPins(index)) return {}
  return {
    async setPinned(entry, pinned) {
      const workspaceId = getBrowserWorkspaceId()
      const resolved = await index.resolveDocument({ workspaceId, path: entry.path })
      if (resolved === null) throw new Error(`No document at "${entry.path}" to pin`)
      await index.setDocumentPinned({ workspaceId, documentId: resolved.documentId, pinned })
    },
  }
}

/**
 * Present exactly when the index keeps a trash (the tree index does; the port
 * does not promise one). Structural rather than instanceof, for the same
 * cross-realm reason ports' isWorkspaceNotFoundError exists.
 */
function trashMembers(
  index: DocumentIndex,
): Pick<WorkspaceFilesSource, 'listTrash' | 'restoreFromTrash' | 'purgeFromTrash'> {
  if (!hasDocumentTrash(index)) return {}
  const folding: DocumentTrash = index
  return {
    async listTrash() {
      const rows = await folding.listTrash({ workspaceId: getBrowserWorkspaceId() })
      return rows.map((row) => ({
        documentId: row.documentId,
        path: row.path,
        deletedAt: row.deletedAt,
      }))
    },
    async restoreFromTrash(documentId) {
      const restored = await folding.restoreDocument({
        workspaceId: getBrowserWorkspaceId(),
        documentId,
      })
      // null means nothing came back — surfacing it is what lets the
      // section show its restore error instead of silently reloading
      // with the row still there. The daemon path already rejects here
      // (its route answers 404); the two keepers must agree.
      if (restored === null) {
        throw new Error(`Nothing restorable for "${documentId}"`)
      }
    },
    async purgeFromTrash(documentId) {
      // false means the trash held no such entry; rejecting is what the
      // daemon's 404 does, so both keepers fail alike.
      const purged = await folding.purgeTrashEntry({
        workspaceId: getBrowserWorkspaceId(),
        documentId,
      })
      if (!purged) throw new Error(`Nothing in the trash for "${documentId}"`)
    },
  }
}

/**
 * `WorkspaceFilesSource` over the browser stores — the adapter that
 * lets the three-pane document browser serve local mode, which is what the
 * seam exists for.
 *
 * Reads go through the same `DocumentIndex`/`LoroStore` pair the editor
 * uses, so the browser and the editor cannot disagree about what exists or
 * what it currently says.
 */
export function createLocalFilesSource(
  deps: {
    // Injectable so the page can hand the panel the SAME stores it was
    // given: two index instances happen to agree because they open one
    // database, but an injected test double does not have that luck, and
    // the panel silently reading a different store than the page is exactly
    // the split this parameter closes.
    index?: DocumentIndex
    loro?: LoroStoreLike
    clock?: ContentClock
  } = {},
): WorkspaceFilesSource {
  // The default matches what production injects (App.tsx): the tree index
  // behind the startup fold. Defaulting to the legacy row index would list
  // a store the app no longer writes to.
  const index = deps.index ?? new FoldingBrowserIndex()
  const loro = deps.loro ?? new LoroStore()
  const clock = deps.clock ?? idbContentClock()

  /**
   * The searchable corpus, built on FIRST search rather than at list time
   * and kept per document until that document's content stamp moves.
   *
   * Measured before choosing this shape: 60 documents (202KB of bodies) read
   * in 176ms against real IndexedDB, ~2.9ms per document. Building it in
   * `listDocuments` would put that on every panel open — including the
   * opens where nobody searches — so it waits for a query and then only
   * re-reads what changed. The same numbers say where this stops being
   * enough: a few thousand documents is seconds, and that is the workspace
   * that needs a persisted index rather than a scan.
   * ponytail: full scan behind a stamp cache; persist an index when a
   * measured workspace makes the first search slow.
   */
  const corpus = new Map<string, { stamp: string; texts: string[] }>()

  /**
   * After a move, repoint references other documents wrote to the old path — the same codec plan the daemon's
   * rename routes apply, so both keepers give one answer. Scans every
   * document rather than keeping a reference index: a rename is a rare,
   * user-initiated click, and the search corpus above already prices the
   * full read (60 documents / 202KB = 176ms against real IndexedDB).
   * ponytail: full scan per rename; share a facts cache with search if a
   * measured workspace makes the click slow.
   *
   * One unreadable document must not abort the rest — the rename already
   * stands, and every reference this CAN repair is one fewer silently
   * broken link.
   */
  async function followReferences(
    entriesBefore: readonly WorkspaceDocumentEntry[],
    moves: readonly DocumentMove[],
  ): Promise<void> {
    const plan = planReferenceRewrite({
      entries: entriesBefore.map((entry) => ({
        id: entry.documentId,
        path: entry.path,
        ...(entry.name === undefined ? {} : { name: entry.name }),
      })),
      moves,
    })
    if (plan.size === 0) return
    const entries = await index.listDocuments({ workspaceId: getBrowserWorkspaceId() })
    for await (const read of readableDocuments(entries)) {
      if (!rewriteReferencesIn(read, plan)) continue
      try {
        await loro.save(read.documentId, read.doc.export({ mode: 'snapshot' }))
        // The content moved, so the search corpus entry for it is stale.
        corpus.delete(read.documentId)
      } catch {
        // Unsaveable: leave it; the reference stays as written.
      }
    }
  }

  const loadCurrentDoc = (entry: WorkspaceDocumentEntry, record?: () => Promise<ContentRecord>) =>
    loadCurrentDocFrom(loro, entry, record)
  const readableDocuments = (entries: readonly ReadableEntry[]) => readDocumentsFrom(loro, entries)

  const bearersByDocument = createTagBearersCache(readableDocuments)

  /**
   * One document's searchable text, from the corpus cache when the content
   * has not moved.
   *
   * Only the TEXT is cached, and only against the content stamp: path and
   * name are PLACEMENT, which a rename moves without touching the content,
   * so caching them here would keep matching a name the workspace has
   * stopped using.
   *
   * An unreadable document is searched as its name and path alone rather
   * than dropping out of results entirely, and that miss is NOT cached —
   * the next search should try the document again.
   */
  async function searchableTextsFor(
    entry: WorkspaceDocumentEntry,
    record: () => Promise<ContentRecord>,
  ): Promise<string[]> {
    const stamp = entry.updatedAt ?? ''
    const cached = corpus.get(entry.documentId)
    if (cached !== undefined && cached.stamp === stamp) return cached.texts
    try {
      const doc = await loadCurrentDoc(entry, record)
      const texts = searchableTexts(readDocumentContent(doc, entry.kind))
      corpus.set(entry.documentId, { stamp, texts })
      return texts
    } catch {
      return []
    }
  }

  return {
    // One well-known path per library, the same constants the daemon reads:
    // nothing here can ask the index which document carries a facet either,
    // and the two keepers must agree on where a library lives.
    readTagLibrary: () => readLibrary(index, loadCurrentDoc, TAG_LIBRARY_PATH, readTagLibrary),
    readStencilLibrary: () =>
      readLibrary(index, loadCurrentDoc, STENCIL_LIBRARY_PATH, readStencilLibrary),
    async listTagsInUse() {
      const entries = await index.listDocuments({ workspaceId: getBrowserWorkspaceId() })
      const stamps = await clock(entries.map((entry) => entry.documentId))
      const bearers = await bearersByDocument(entries, stamps)
      return tagsInUse([...bearers.values()].flat())
    },
    async listDocuments(): Promise<readonly WorkspaceDocumentEntry[]> {
      let entries: Awaited<ReturnType<DocumentIndex['listDocuments']>>
      try {
        entries = await index.listDocuments({ workspaceId: getBrowserWorkspaceId() })
      } catch (err) {
        // The panel's not-found state is mode-independent: this is the local
        // spelling of the daemon's 404.
        if (err instanceof WorkspaceNotFoundError) {
          throw new WorkspaceMissingError(getBrowserWorkspaceId())
        }
        throw err
      }
      if (entries.length === 0) return []
      const pinOrderById = await readPinOrder(index)
      const stamps = await clock(entries.map((entry) => entry.documentId))
      // Tags for search and the filter chips: the local spelling of the
      // daemon's tag projection. A board's own tags are the document's
      // (ADR-0040 decision 2); what its boxes and edges carry is the carried
      // set that lets the `#tag` filter find the board (decision 3).
      const bearers = await bearersByDocument(entries, stamps)
      const tagsById = new Map<string, readonly string[]>()
      const carriedById = new Map<string, readonly string[]>()
      for (const [documentId, found] of bearers) {
        const { own, carried } = splitBearerTags(found)
        if (own.length > 0) tagsById.set(documentId, own)
        if (carried.length > 0) carriedById.set(documentId, carried)
      }
      return entries.map((entry) => ({
        documentId: entry.documentId,
        path: entry.path,
        ...optional('name', entry.name),
        ...optional('kind', entry.kind),
        ...optional('shadowed', entry.shadowed),
        ...optional('tags', tagsById.get(entry.documentId)),
        ...optional('carriedTags', carriedById.get(entry.documentId)),
        ...optional('updatedAt', stamps.get(entry.documentId)),
        ...optional('contentDigest', entry.contentDigest),
        ...optional('pinOrder', pinOrderById.get(entry.documentId)),
      }))
    },

    async createDocument(path: string, kind: DocumentKind, name?: string): Promise<void> {
      await ensureLocalWorkspace(index)
      const trimmed = name?.trim()
      const entry = await index.createDocument({
        workspaceId: getBrowserWorkspaceId(),
        path,
        kind,
        ...(trimmed ? { name: trimmed } : {}),
      })
      // Seeded like every other local create: a document with no content
      // record has no last-edited time and nothing to open. Rolled back if
      // the seed fails, so a failed create never leaves a row with nothing
      // behind it.
      try {
        await loro.save(entry.documentId, loro.createEmptySnapshot())
      } catch (err) {
        try {
          await index.deleteDocument({ workspaceId: getBrowserWorkspaceId(), path: entry.path })
        } catch {
          // Best-effort: a stray index row is harmless next to reporting a
          // create that did not happen.
        }
        throw err
      }
    },

    async renameDocumentPath(path: string, newPath: string): Promise<void> {
      const entriesBefore = await this.listDocuments()
      await index.moveDocument({ workspaceId: getBrowserWorkspaceId(), from: path, to: newPath })
      // Every path the SUBTREE carried, derived rather than written here.
      // The move already stands: a follow failure repairs less, it must not
      // turn a completed rename into a rejection.
      try {
        await followReferences(entriesBefore, movesForPathChange(entriesBefore, path, newPath))
      } catch {
        // References the pass could not reach stay as written.
      }
    },

    async searchDocuments(query, limit = 20) {
      if (query.trim() === '') return []
      const entries = await this.listDocuments()
      const searchable: SearchableDocument[] = []
      const record = lazyContentRecord()
      for (const entry of entries) {
        searchable.push({
          documentId: entry.documentId,
          path: entry.path,
          ...optional('name', entry.name),
          texts: await searchableTextsFor(entry, record),
        })
      }
      const byId = new Map(entries.map((entry) => [entry.documentId, entry]))
      // Every hit here is a keyword hit — there is no embedder in the
      // browser — so each carries its rank, and the panel highlights.
      let rank = 0
      // The emoji vocabulary arrives by DYNAMIC import, the same way the
      // `:` completion takes it and for the same reason: `catalog-data`
      // (68KB) plus `catalog-ja` (115KB) is 183KB whose only job is to make
      // a picture findable, and somebody who never opens the files search
      // should not carry it. The daemon takes it statically — a server has
      // no bundle to keep small, and it indexes on every call.
      const { emojiSearchText } = await import(
        '@kamiazya/whiteboard-plugin-visual/emoji/searchable'
      )
      return fullTextSearch(searchable, query, { limit, alsoIndex: emojiSearchText }).flatMap(
        (hit) => {
          const document = byId.get(hit.documentId)
          rank += 1
          return document === undefined
            ? []
            : [{ document, contexts: [...hit.contexts], lexicalRank: rank }]
        },
      )
    },

    async setDocumentName(entry, name): Promise<void> {
      await index.setDocumentName({
        workspaceId: getBrowserWorkspaceId(),
        documentId: entry.documentId,
        // The port spells "clear" as absence, not empty string. No follow
        // pass here: name references are being retired from resolution, so
        // a name change breaks nothing worth rewriting.
        ...(name === undefined ? {} : { name }),
      })
    },

    async loadMarkdown(entry: WorkspaceDocumentEntry): Promise<LoadedMarkdown> {
      // The BODY, not an OKF serialization: the reads behind this method feed
      // the thumbnail and preview renderers, which draw markdown — a
      // frontmatter block would be drawn as text on every card.
      //
      // The facets come off the SAME decoded document. Reading them from a
      // second load would be a second decode per visible row.
      const doc = await loadCurrentDoc(entry)
      return { body: readMarkdownBody(doc), facets: readFacets(doc) }
    },

    async loadSpatialSnapshot(entry: WorkspaceDocumentEntry): Promise<Uint8Array> {
      return (await loadCurrentDoc(entry)).export({ mode: 'snapshot' })
    },

    ...pinMembers(index),
    ...trashMembers(index),
  }
}
