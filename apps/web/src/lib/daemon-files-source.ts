import type { DocumentKind } from '@kamiazya/whiteboard-model'
import {
  createDocument,
  DaemonApiError,
  getDocumentOkfV1,
  getDocumentSnapshot,
  getWorkspaceDocumentTags,
  getWorkspaceNames,
  listDocuments,
  listTrash,
  renameDocumentPath,
  restoreFromTrash,
  searchWorkspaceDocuments,
  setDocumentDisplayName,
  setDocumentPinned,
} from './daemon-api-client.js'
import { optional, type WorkspaceDocumentEntry } from './document-entry.js'
import {
  type LoadedMarkdown,
  type WorkspaceFilesSource,
  WorkspaceMissingError,
} from './files-source.js'

/**
 * One tag read per LIST read, shared by everyone who asks about tags.
 *
 * Three callers want the same route in one breath: the list (rows carry their
 * tags), the panel's chip count, and the page's vocabulary hook. The first two
 * are SEQUENTIAL — the chips are reloaded once the list has landed — so an
 * in-flight-only dedupe could not see them, and an addressed cold load paid
 * for the vocabulary twice.
 *
 * `read` answers from what is held; `refresh` is what the list calls, since a
 * list read is this source's one reason to ask again. That is exactly the
 * freshness `useTagsInUse` documents ("reloaded with the list"): the chips
 * count the tags that came back with the rows they are drawn beside.
 *
 * A rejection is NOT held. Holding one would leave a source that failed once
 * answering from that failure for as long as it lives.
 */
function heldTagRead(
  daemonFetch: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
) {
  let held: ReturnType<typeof getWorkspaceDocumentTags> | null = null
  const refresh = () => {
    const asked = getWorkspaceDocumentTags(daemonFetch, daemonBaseUrl, workspaceId)
    held = asked
    void asked.catch(() => {
      if (held === asked) held = null
    })
    return asked
  }
  return { read: () => held ?? refresh(), refresh }
}

/**
 * `WorkspaceFilesSource` over the daemon's HTTP API — the same five client
 * calls `WorkspaceFilesPanel` used to make itself, moved behind the seam so
 * the panel stops being daemon-only.
 *
 * The one piece of translation is the 404: the panel's not-found state is
 * mode-independent, so the daemon's `DaemonApiError(404)` becomes the seam's
 * `WorkspaceMissingError` here rather than leaking into the panel.
 */
export function createDaemonFilesSource(
  daemonFetch: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
): WorkspaceFilesSource {
  const tags = heldTagRead(daemonFetch, daemonBaseUrl, workspaceId)
  return {
    async listTagsInUse() {
      return (await tags.read()).inUse
    },
    async readTagLibrary() {
      return (await tags.read()).library
    },
    async listDocuments(): Promise<readonly WorkspaceDocumentEntry[]> {
      try {
        // Names ride alongside the list for their pinned[] — pin order is
        // workspace state the /documents response does not carry. A failed
        // names fetch degrades to "nothing pinned", never to a failed list,
        // matching what the grid page did.
        // Tags ride alongside for the same reason as names: search and the
        // filter chips need them, and a failed tag fetch degrades to a
        // tagless list, never to a failed list.
        const [res, names, tagRes] = await Promise.all([
          listDocuments(daemonFetch, daemonBaseUrl, workspaceId),
          getWorkspaceNames(daemonFetch, daemonBaseUrl, workspaceId).catch(() => null),
          tags.refresh().catch(() => null),
        ])
        const pinIndex = new Map((names?.pinned ?? []).map((path, i) => [path, i]))
        const tagsById = new Map((tagRes?.documents ?? []).map((doc) => [doc.documentId, doc.tags]))
        // What a board's boxes and edges carry, so the `#tag` filter finds
        // the board a chip counted from boxes is about (ADR-0040 decision 3).
        const carriedById = new Map(
          (tagRes?.contents ?? []).map((doc) => [doc.documentId, doc.tags]),
        )
        return res.documents.map((entry) => ({
          documentId: entry.id,
          path: entry.path,
          kind: entry.kind,
          ...optional('name', entry.displayName),
          ...optional('updatedAt', entry.updatedAt),
          ...optional('contentDigest', entry.contentDigest),
          ...optional('shadowed', entry.shadowed),
          ...optional('tags', tagsById.get(entry.id)),
          ...optional('carriedTags', carriedById.get(entry.id)),
          ...optional('pinOrder', pinIndex.get(entry.path)),
        }))
      } catch (err) {
        if (err instanceof DaemonApiError && err.status === 404) {
          throw new WorkspaceMissingError(workspaceId)
        }
        throw err
      }
    },

    async createDocument(path: string, kind: DocumentKind, name?: string): Promise<void> {
      await createDocument(daemonFetch, daemonBaseUrl, workspaceId, path, kind, name)
    },

    async renameDocumentPath(path: string, newPath: string): Promise<void> {
      await renameDocumentPath(daemonFetch, daemonBaseUrl, workspaceId, path, newPath)
    },

    async searchDocuments(query, limit = 20) {
      if (query.trim() === '') return []
      const res = await searchWorkspaceDocuments(
        daemonFetch,
        daemonBaseUrl,
        workspaceId,
        query,
        limit,
      )
      return res.results.map((hit) => ({
        document: {
          documentId: hit.documentId,
          path: hit.path,
          ...(hit.name === undefined ? {} : { name: hit.name }),
          ...(hit.kind === undefined ? {} : { kind: hit.kind }),
        },
        contexts: hit.contexts,
        ...(hit.lexicalRank === undefined ? {} : { lexicalRank: hit.lexicalRank }),
        ...(hit.semanticRank === undefined ? {} : { semanticRank: hit.semanticRank }),
      }))
    },

    async setDocumentName(entry, name): Promise<void> {
      // The API spells "clear" as an empty string (PUT name deletes on '').
      await setDocumentDisplayName(daemonFetch, daemonBaseUrl, workspaceId, entry.path, name ?? '')
    },

    async setPinned(entry, pinned): Promise<void> {
      await setDocumentPinned(daemonFetch, daemonBaseUrl, workspaceId, entry.path, pinned)
    },

    async loadMarkdown(entry: WorkspaceDocumentEntry): Promise<LoadedMarkdown> {
      // `body`, not `markdown`: the route answers with both, and `markdown`
      // is the OKF projection — frontmatter block included — which the
      // thumbnail and preview renderers would draw as prose.
      const okf = await getDocumentOkfV1(daemonFetch, daemonBaseUrl, workspaceId, entry.documentId)
      const facets = okf.frontmatter.facets
      return { body: okf.body, ...(facets === undefined ? {} : { facets }) }
    },

    loadSpatialSnapshot(entry: WorkspaceDocumentEntry): Promise<Uint8Array> {
      return getDocumentSnapshot(daemonFetch, daemonBaseUrl, workspaceId, entry.path)
    },

    async listTrash() {
      return (await listTrash(daemonFetch, daemonBaseUrl, workspaceId)).entries
    },

    async restoreFromTrash(documentId: string): Promise<void> {
      await restoreFromTrash(daemonFetch, daemonBaseUrl, workspaceId, documentId)
    },
  }
}
