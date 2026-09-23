import {
  type DocumentMove,
  movesForPathChange,
  planReferenceRewrite,
  rewriteCanvasReferences,
  rewriteReferenceTargets,
} from '@kamiazya/whiteboard-codec'
import {
  readCoreFacets,
  readFacets,
  readMarkdownBody,
  readSpatialCanvas,
  writeMarkdownBody,
  writeSpatialNode,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  type DocumentKind,
  type SpatialCanvas,
  type TagBearerKind,
  tagsInUse,
} from '@kamiazya/whiteboard-model'
import { readTagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import { type DocumentIndex, WorkspaceNotFoundError } from '@kamiazya/whiteboard-ports'
import {
  fullTextSearch,
  type SearchableDocument,
  searchableTexts,
} from '@kamiazya/whiteboard-search'
import type { Loro } from 'loro-crdt'
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
import { LoroStore, type LoroStoreLike } from './loro-store.js'
import { loadDocumentContent } from './workspace-content.js'

/**
 * One document read from the store, discriminated by kind — a board carries
 * its parsed canvas because every caller that wants a board wants that.
 */
type LoadedDocument =
  | { documentId: string; kind: 'markdown'; doc: Loro }
  | { documentId: string; kind: 'spatial'; doc: Loro; canvas: SpatialCanvas }

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
  if (read.kind === 'spatial') {
    const result = rewriteCanvasReferences(read.canvas, plan)
    if (!result.changed) return false
    for (const node of result.changedNodes) writeSpatialNode(read.doc, node)
    return true
  }
  const body = readMarkdownBody(read.doc)
  const next = rewriteReferenceTargets(body, plan)
  if (next === body) return false
  writeMarkdownBody(read.doc, next)
  return true
}

/** What a document contributes to the workspace's tag vocabulary. */
function tagBearersOf(read: LoadedDocument): { what: TagBearerKind; tags: readonly string[] }[] {
  if (read.kind === 'markdown') {
    return [{ what: 'document', tags: readCoreFacets(read.doc)?.tags ?? [] }]
  }
  const { canvas } = read
  return [
    { what: 'board' as const, tags: canvas.tags ?? [] },
    ...canvas.nodes.map((node) => ({ what: 'node' as const, tags: node.tags ?? [] })),
    ...canvas.edges.map((edge) => ({ what: 'edge' as const, tags: edge.tags ?? [] })),
  ]
}

/**
 * The tags a LISTING shows for one document: the document's own, and — for a
 * board — what its boxes and edges carry, deduplicated beside them.
 *
 * A board's own tags are the document's (ADR-0040 decision 2); the carried
 * set is what makes the `#tag` filter find the board (decision 3), and is the
 * browser spelling of the daemon's `/document-tags` `contents`.
 */
function listedTagsOf(read: LoadedDocument): {
  own: readonly string[]
  carried: readonly string[]
} {
  if (read.kind === 'markdown') return { own: readCoreFacets(read.doc)?.tags ?? [], carried: [] }
  const { canvas } = read
  const carried = new Set<string>()
  for (const node of canvas.nodes) for (const tag of node.tags ?? []) carried.add(tag)
  for (const edge of canvas.edges) for (const tag of edge.tags ?? []) carried.add(tag)
  return { own: canvas.tags ?? [], carried: [...carried] }
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

  async function loadCurrentDoc(entry: WorkspaceDocumentEntry): Promise<Loro> {
    const doc = await loadDocumentContent(entry.documentId, { loro })
    if (doc === null) throw new Error(`document ${entry.documentId} holds no readable content`)
    return doc
  }

  /**
   * Every document's content, read and its KIND resolved, skipping what this
   * build cannot read.
   *
   * Four methods here each wrote this walk out — list, load, skip the kinds
   * that carry no content, branch on markdown vs spatial — and the branch is
   * the one place the two stop being interchangeable. Skipping rather than
   * failing is the rule everywhere it appears, and for one reason: a rename
   * that repairs nine references of ten beats one that repairs none, and a
   * panel that lists a tagless row beats one that does not open.
   */
  async function* readableDocuments(
    entries: readonly { documentId: string; path: string; kind?: string }[],
  ): AsyncGenerator<LoadedDocument> {
    for (const entry of entries) {
      if (entry.kind !== 'markdown' && entry.kind !== 'spatial') continue
      let doc: Loro
      try {
        doc = await loadCurrentDoc({ documentId: entry.documentId, path: entry.path })
      } catch {
        continue
      }
      if (entry.kind === 'markdown') {
        yield { documentId: entry.documentId, kind: 'markdown', doc }
        continue
      }
      try {
        yield { documentId: entry.documentId, kind: 'spatial', doc, canvas: readSpatialCanvas(doc) }
      } catch {
        // A canvas this build cannot parse is the same miss as an unreadable
        // document: it carries nothing anyone here can read.
      }
    }
  }

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
  async function searchableTextsFor(entry: WorkspaceDocumentEntry): Promise<string[]> {
    const stamp = entry.updatedAt ?? ''
    const cached = corpus.get(entry.documentId)
    if (cached !== undefined && cached.stamp === stamp) return cached.texts
    try {
      const doc = await loadCurrentDoc(entry)
      const texts =
        entry.kind === 'spatial'
          ? searchableTexts({ kind: 'spatial', canvas: readSpatialCanvas(doc) })
          : searchableTexts({ kind: 'markdown', body: readMarkdownBody(doc) })
      corpus.set(entry.documentId, { stamp, texts })
      return texts
    } catch {
      return []
    }
  }

  return {
    async readTagLibrary() {
      // One well-known path, the daemon's convention (`TAG_LIBRARY_PATH`):
      // nothing here can ask the index which document carries a facet
      // either, and the two keepers must agree on where a library lives.
      const entries = await index.listDocuments({ workspaceId: getBrowserWorkspaceId() })
      const library = entries.find((entry) => entry.path === 'tags')
      if (library === undefined) return {}
      try {
        return readTagLibrary(readFacets(await loadCurrentDoc(library)))
      } catch {
        return {}
      }
    },
    async listTagsInUse() {
      const entries = await index.listDocuments({ workspaceId: getBrowserWorkspaceId() })
      const bearers: { what: TagBearerKind; tags: readonly string[] }[] = []
      for await (const read of readableDocuments(entries)) bearers.push(...tagBearersOf(read))
      return tagsInUse(bearers)
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
      const stamps = await clock(entries.map((entry) => entry.documentId))
      // Tags for search and the filter chips. Loading every markdown doc at
      // list time is the local spelling of the daemon's tag projection —
      // IndexedDB reads, so cheap at this scale; an unreadable document
      // simply lists tagless rather than failing the list.
      // ponytail: O(N) doc loads per listing; cache per-document when a
      // measured workspace makes the panel open slowly.
      const tagsById = new Map<string, readonly string[]>()
      const carriedById = new Map<string, readonly string[]>()
      for await (const read of readableDocuments(entries)) {
        const { own, carried } = listedTagsOf(read)
        if (own.length > 0) tagsById.set(read.documentId, own)
        if (carried.length > 0) carriedById.set(read.documentId, carried)
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
      for (const entry of entries) {
        searchable.push({
          documentId: entry.documentId,
          path: entry.path,
          ...optional('name', entry.name),
          texts: await searchableTextsFor(entry),
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

    // Present exactly when the index keeps a trash (the tree index does; the
    // port does not promise one). Structural rather than instanceof, for the
    // same cross-realm reason ports' isWorkspaceNotFoundError exists.
    ...('listTrash' in index && 'restoreDocument' in index
      ? {
          async listTrash() {
            const rows = await (index as FoldingBrowserIndex).listTrash({
              workspaceId: getBrowserWorkspaceId(),
            })
            return rows.map((row) => ({
              documentId: row.documentId,
              path: row.path,
              deletedAt: row.deletedAt,
            }))
          },
          async restoreFromTrash(documentId: string) {
            const restored = await (index as FoldingBrowserIndex).restoreDocument({
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
        }
      : {}),
  }
}
