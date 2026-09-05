import {
  type DocumentMove,
  movesForPathChange,
  planReferenceRewrite,
  rewriteCanvasReferences,
  rewriteReferenceTargets,
} from '@kamiazya/whiteboard-codec'
import {
  readCoreFacets,
  readMarkdownBody,
  readSpatialCanvas,
  writeMarkdownBody,
  writeSpatialNode,
} from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { type DocumentIndex, WorkspaceNotFoundError } from '@kamiazya/whiteboard-ports'
import {
  fullTextSearch,
  type SearchableDocument,
  searchableTexts,
} from '@kamiazya/whiteboard-search'
import { Loro } from 'loro-crdt'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import type { WorkspaceDocumentEntry } from './document-entry.js'
import { type WorkspaceFilesSource, WorkspaceMissingError } from './files-source.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'
import {
  type ContentClock,
  ensureLocalWorkspace,
  idbContentClock,
} from './local-document-summary.js'
import { LoroStore, type LoroStoreLike } from './loro-store.js'
import { loadWorkspaceDocumentProjection } from './workspace-content.js'

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
    for (const entry of entries) {
      try {
        const doc = await loadCurrentDoc(entry)
        if (entry.kind === 'spatial') {
          const result = rewriteCanvasReferences(readSpatialCanvas(doc), plan)
          if (!result.changed) continue
          // Targeted writes, never a whole-canvas resync: readSpatialCanvas
          // drops records this build cannot parse, and writing the whole
          // canvas back would DELETE them.
          for (const node of result.changedNodes) writeSpatialNode(doc, node)
        } else {
          const body = readMarkdownBody(doc)
          const next = rewriteReferenceTargets(body, plan)
          if (next === body) continue
          writeMarkdownBody(doc, next)
        }
        await loro.save(entry.documentId, doc.export({ mode: 'snapshot' }))
        // The content moved, so the search corpus entry for it is stale.
        corpus.delete(entry.documentId)
      } catch {
        // Unreadable or unsaveable: leave it; the reference stays as written.
      }
    }
  }

  async function loadCurrentDoc(entry: WorkspaceDocumentEntry): Promise<Loro> {
    // The workspace document first — that is where the editor persists — and
    // the injected per-document store as the fallback, which is also what an
    // injected test double exercises.
    const projected = await loadWorkspaceDocumentProjection(entry.documentId)
    if (projected !== null) return projected
    const loaded = await loro.load(entry.documentId)
    if (loaded.kind !== 'ok') {
      throw new Error(`document ${entry.documentId} is not readable: ${loaded.kind}`)
    }
    const doc = new Loro()
    doc.import(loaded.snapshot)
    // The log too: a thumbnail of the last snapshot alone is a picture of a
    // document the user is not looking at.
    for (const delta of loaded.deltas ?? []) doc.import(delta)
    return doc
  }

  return {
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
      for (const entry of entries) {
        if (entry.kind !== 'markdown') continue
        try {
          const tags = readCoreFacets(
            await loadCurrentDoc({ documentId: entry.documentId, path: entry.path }),
          )?.tags
          if (tags !== undefined && tags.length > 0) tagsById.set(entry.documentId, tags)
        } catch {
          // unreadable or never written: no tags to show
        }
      }
      return entries.map((entry) => ({
        documentId: entry.documentId,
        path: entry.path,
        ...(entry.name === undefined ? {} : { name: entry.name }),
        ...(entry.kind === undefined ? {} : { kind: entry.kind }),
        ...(entry.shadowed === undefined ? {} : { shadowed: entry.shadowed }),
        ...(tagsById.has(entry.documentId)
          ? { tags: tagsById.get(entry.documentId) as readonly string[] }
          : {}),
        ...(stamps.has(entry.documentId)
          ? { updatedAt: stamps.get(entry.documentId) as string }
          : {}),
        ...(entry.contentDigest === undefined ? {} : { contentDigest: entry.contentDigest }),
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
        // Only the TEXT is cached, and only against the content stamp. Path
        // and name are placement, which a rename moves without touching the
        // content — caching them here would keep matching a name the
        // workspace has stopped using.
        const stamp = entry.updatedAt ?? ''
        const cached = corpus.get(entry.documentId)
        let texts: string[]
        if (cached !== undefined && cached.stamp === stamp) {
          texts = cached.texts
        } else {
          try {
            const doc = await loadCurrentDoc(entry)
            texts =
              entry.kind === 'spatial'
                ? searchableTexts({ kind: 'spatial', canvas: readSpatialCanvas(doc) })
                : searchableTexts({ kind: 'markdown', body: readMarkdownBody(doc) })
            corpus.set(entry.documentId, { stamp, texts })
          } catch {
            // Unreadable documents are searched as their name and path alone
            // rather than dropping out of results entirely. Not cached: the
            // next search should try the document again.
            texts = []
          }
        }
        searchable.push({
          documentId: entry.documentId,
          path: entry.path,
          ...(entry.name === undefined ? {} : { name: entry.name }),
          texts,
        })
      }
      const byId = new Map(entries.map((entry) => [entry.documentId, entry]))
      // Every hit here is a keyword hit — there is no embedder in the
      // browser — so each carries its rank, and the panel highlights.
      let rank = 0
      return fullTextSearch(searchable, query, { limit }).flatMap((hit) => {
        const document = byId.get(hit.documentId)
        rank += 1
        return document === undefined
          ? []
          : [{ document, contexts: [...hit.contexts], lexicalRank: rank }]
      })
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

    async loadMarkdown(entry: WorkspaceDocumentEntry): Promise<string> {
      // The BODY, not an OKF serialization: the reads behind this method feed
      // the thumbnail and preview renderers, which draw markdown — a
      // frontmatter block would be drawn as text on every card.
      return readMarkdownBody(await loadCurrentDoc(entry))
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
