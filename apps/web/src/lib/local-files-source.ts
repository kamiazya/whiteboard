import { readCoreFacets, readMarkdownBody } from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { type DocumentIndex, WorkspaceNotFoundError } from '@kamiazya/whiteboard-ports'
import { Loro } from 'loro-crdt'
import type { WorkspaceDocumentEntry } from '../components/workspace-files/document-entry.js'
import {
  type WorkspaceFilesSource,
  WorkspaceMissingError,
} from '../components/workspace-files/files-source.js'
import { IdbDocumentIndex } from './idb-document-index.js'
import {
  type ContentClock,
  ensureLocalWorkspace,
  idbContentClock,
  LOCAL_WORKSPACE_ID,
} from './local-document-summary.js'
import { LoroStore, type LoroStoreLike } from './loro-store.js'

/**
 * `WorkspaceFilesSource` over the browser-local stores — the adapter that
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
    // given: two IdbDocumentIndex instances happen to agree because they
    // open one database, but an injected test double does not have that
    // luck, and the panel silently reading a different store than the page
    // is exactly the split this parameter closes.
    index?: DocumentIndex
    loro?: LoroStoreLike
    clock?: ContentClock
  } = {},
): WorkspaceFilesSource {
  const index = deps.index ?? new IdbDocumentIndex()
  const loro = deps.loro ?? new LoroStore()
  const clock = deps.clock ?? idbContentClock()

  async function loadCurrentDoc(entry: WorkspaceDocumentEntry): Promise<Loro> {
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
        entries = await index.listDocuments({ workspaceId: LOCAL_WORKSPACE_ID })
      } catch (err) {
        // The panel's not-found state is mode-independent: this is the local
        // spelling of the daemon's 404.
        if (err instanceof WorkspaceNotFoundError) {
          throw new WorkspaceMissingError(LOCAL_WORKSPACE_ID)
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
        ...(tagsById.has(entry.documentId)
          ? { tags: tagsById.get(entry.documentId) as readonly string[] }
          : {}),
        ...(stamps.has(entry.documentId)
          ? { updatedAt: stamps.get(entry.documentId) as string }
          : {}),
      }))
    },

    async createDocument(path: string, kind: DocumentKind): Promise<void> {
      await ensureLocalWorkspace(index)
      const entry = await index.createDocument({ workspaceId: LOCAL_WORKSPACE_ID, path, kind })
      // Seeded like every other local create: a document with no content
      // record has no last-edited time and nothing to open. Rolled back if
      // the seed fails, so a failed create never leaves a row with nothing
      // behind it.
      try {
        await loro.save(entry.documentId, loro.createEmptySnapshot())
      } catch (err) {
        try {
          await index.deleteDocument({ workspaceId: LOCAL_WORKSPACE_ID, path: entry.path })
        } catch {
          // Best-effort: a stray index row is harmless next to reporting a
          // create that did not happen.
        }
        throw err
      }
    },

    async renameDocumentPath(path: string, newPath: string): Promise<void> {
      await index.moveDocument({ workspaceId: LOCAL_WORKSPACE_ID, from: path, to: newPath })
    },

    async setDocumentName(entry, name): Promise<void> {
      await index.setDocumentName({
        workspaceId: LOCAL_WORKSPACE_ID,
        documentId: entry.documentId,
        // The port spells "clear" as absence, not empty string.
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
  }
}
