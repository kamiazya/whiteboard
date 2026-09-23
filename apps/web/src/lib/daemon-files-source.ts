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
  type TrashRow,
  type WorkspaceFilesSource,
  WorkspaceMissingError,
} from './files-source.js'

/**
 * One answer, held until something says the data changed.
 *
 * The daemon's index screen has several readers of the same few routes: the
 * page (which decides onboarding and derives create paths from the list),
 * the panel it renders, the panel's chip count, the trash section, and the
 * page's vocabulary hook. Each asked on its own, one after another — so an
 * in-flight dedupe could not see them, and an addressed cold load paid for
 * the list twice, the names twice and the trash twice.
 *
 * `read` answers from what is held. `refresh` asks again and holds that, and
 * is called by whoever KNOWS the data moved: the page after its own writes,
 * and this source after every write it makes itself. A reader never forces a
 * refresh, so a later reader sees what the last refresh read — the same
 * freshness it had when it asked a few milliseconds after the page did.
 *
 * A rejection is NOT held. Holding one would leave a source that failed once
 * answering from that failure for as long as it lives.
 */
function heldRead<T>(ask: () => Promise<T>) {
  let held: Promise<T> | null = null
  const refresh = () => {
    const asked = ask()
    held = asked
    void asked.catch(() => {
      if (held === asked) held = null
    })
    return asked
  }
  return {
    read: () => held ?? refresh(),
    refresh,
    /** The next read asks again. */
    forget: () => {
      held = null
    },
  }
}

/**
 * The workspace's list as the panel renders it: the documents, with each
 * one's pin order (from `names`) and tags (from the tag projection) folded in.
 *
 * Names and tags ride alongside because the /documents response carries
 * neither pin order nor tags, and search and the filter chips need both. A
 * failed names or tags fetch degrades to "nothing pinned" or "tagless",
 * never to a failed list. The tag read goes through `refreshTags` so every
 * other asker of the vocabulary reads what came back with these rows.
 *
 * The one piece of translation is the 404: the panel's not-found state is
 * mode-independent, so the daemon's `DaemonApiError(404)` becomes the seam's
 * `WorkspaceMissingError` here rather than leaking into the panel.
 */
async function readListing(
  daemonFetch: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  refreshTags: () => ReturnType<typeof getWorkspaceDocumentTags>,
): Promise<readonly WorkspaceDocumentEntry[]> {
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
      refreshTags().catch(() => null),
    ])
    const pinIndex = new Map((names?.pinned ?? []).map((path, i) => [path, i]))
    const tagsById = new Map((tagRes?.documents ?? []).map((doc) => [doc.documentId, doc.tags]))
    // What a board's boxes and edges carry, so the `#tag` filter finds
    // the board a chip counted from boxes is about (ADR-0040 decision 3).
    const carriedById = new Map((tagRes?.contents ?? []).map((doc) => [doc.documentId, doc.tags]))
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
}

/**
 * `WorkspaceFilesSource` over the daemon's HTTP API — the client calls
 * `WorkspaceFilesPanel` used to make itself, moved behind the seam so the
 * panel stops being daemon-only.
 *
 * It is also the index SCREEN's one reader of the list and the trash: the
 * page reads through it (`refresh`) and the panel, its chips and the trash
 * section read what that held — see `heldRead`.
 */
export interface DaemonFilesSource extends WorkspaceFilesSource {
  /**
   * Read the list and the trash afresh, and hold both for every other reader.
   * What the page calls when it knows the data moved — on load, and after
   * its own create, duplicate and delete. The trash is `null` when it could
   * not be read: a missing count degrades to "nothing in the trash", never
   * to a failed list.
   */
  refresh(): Promise<{
    readonly entries: readonly WorkspaceDocumentEntry[]
    readonly trash: readonly TrashRow[] | null
  }>
}

export function createDaemonFilesSource(
  daemonFetch: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
): DaemonFilesSource {
  const tags = heldRead(() => getWorkspaceDocumentTags(daemonFetch, daemonBaseUrl, workspaceId))
  const list = heldRead(() => readListing(daemonFetch, daemonBaseUrl, workspaceId, tags.refresh))
  const trash = heldRead(
    async () => (await listTrash(daemonFetch, daemonBaseUrl, workspaceId)).entries,
  )
  // Every write through this source changes what the list holds — including
  // one that FAILED, since a rename's first half may have landed — so the
  // next read asks again whatever the write answered.
  const afterWrite = async (write: Promise<unknown>, alsoTrash = false): Promise<void> => {
    try {
      await write
    } finally {
      list.forget()
      if (alsoTrash) trash.forget()
    }
  }
  return {
    async refresh() {
      const [entries, trashRows] = await Promise.all([
        list.refresh(),
        trash.refresh().catch(() => null),
      ])
      return { entries, trash: trashRows }
    },
    async listTagsInUse() {
      return (await tags.read()).inUse
    },
    async readTagLibrary() {
      return (await tags.read()).library
    },
    listDocuments: () => list.read(),

    createDocument: (path: string, kind: DocumentKind, name?: string) =>
      afterWrite(createDocument(daemonFetch, daemonBaseUrl, workspaceId, path, kind, name)),

    renameDocumentPath: (path: string, newPath: string) =>
      afterWrite(renameDocumentPath(daemonFetch, daemonBaseUrl, workspaceId, path, newPath)),

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

    setDocumentName: (entry, name) =>
      // The API spells "clear" as an empty string (PUT name deletes on '').
      afterWrite(
        setDocumentDisplayName(daemonFetch, daemonBaseUrl, workspaceId, entry.path, name ?? ''),
      ),

    setPinned: (entry, pinned) =>
      afterWrite(setDocumentPinned(daemonFetch, daemonBaseUrl, workspaceId, entry.path, pinned)),

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

    listTrash: () => trash.read(),

    restoreFromTrash: (documentId: string) =>
      afterWrite(restoreFromTrash(daemonFetch, daemonBaseUrl, workspaceId, documentId), true),
  }
}
