import { isSelfOrDescendant } from '@kamiazya/whiteboard-model'
import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import type { WorkspaceFilesSource } from '../../lib/files-source.js'
import type { FolderNames } from '../../lib/folder-names.js'
import { foldersOf } from './folder-moves.js'
import { refusalMessage } from './use-rename-document.js'

/**
 * What each folder is called, for every folder-shaped surface — the tree, the
 * trail, the cards, the move list. Empty outside a panel, so a surface
 * rendered alone shows segments rather than failing.
 */
export const FolderNamesContext = createContext<FolderNames>(new Map())

export interface FolderNamesState {
  /** The keeper's names with the pending ones over them. */
  readonly names: FolderNames
  /** Every folder known here: the documents' folders and the pending ones not yet holding any. */
  readonly folders: readonly string[]
  /** A folder made here and named, held until a document lands in it. */
  readonly remember: (path: string, name: string) => void
  /**
   * Write the pending names of the folders a document at `path` now stands in,
   * without waiting for a listing — the caller may leave the page the moment
   * the document exists, and an effect waiting for the listing would never run.
   */
  readonly flushInto: (path: string) => void
  /** Why the keeper refused a pending name it tried to write, until the next attempt. */
  readonly refusal: string | null
  readonly dismissRefusal: () => void
  /** Rename a folder: a pending one in place, a standing one through the keeper. */
  readonly rename: (path: string, name: string) => Promise<void>
  /** Whether a folder at `path` can be renamed here at all. */
  readonly canRename: (path: string) => boolean
}

function withEntry(map: FolderNames, path: string, name: string | undefined): FolderNames {
  const next = new Map(map)
  if (name === undefined) next.delete(path)
  else next.set(path, name)
  return next
}

/** What the keeper names, re-read with every listing: a move or an emptied folder changes it. */
function useStoredFolderNames(
  source: WorkspaceFilesSource,
  documents: readonly WorkspaceDocumentEntry[] | null,
) {
  const [stored, setStored] = useState<FolderNames>(new Map())
  const request = useRef(0)

  const reload = useCallback(async () => {
    const token = ++request.current
    const rows = await source.listFolderNames?.().catch(() => null)
    if (token !== request.current || rows === null || rows === undefined) return
    setStored(new Map(rows.map((row) => [row.path, row.name])))
  }, [source])

  // SCOPE RESET — the departed keeper's names name nothing here.
  useEffect(() => {
    setStored(new Map())
  }, [source])

  useEffect(() => {
    if (documents !== null) void reload()
  }, [documents, reload])

  return { stored, reload }
}

/**
 * Names given to folders no document is in yet, and the flush that writes one
 * once the listing shows a document under it. The pending name stays until
 * the write answers, so the folder never flickers back to its segment; a
 * refused write leaves the segment showing.
 */
function usePendingFolderNames(
  source: WorkspaceFilesSource,
  standing: readonly string[],
  reload: () => Promise<void>,
) {
  const [pending, setPending] = useState<FolderNames>(new Map())
  const writing = useRef(new Set<string>())
  const [refusal, setRefusal] = useState<string | null>(null)

  // SCOPE RESET — a name given in the departed workspace names nothing here.
  useEffect(() => {
    setPending(new Map())
    writing.current = new Set()
    setRefusal(null)
  }, [source])

  const flush = useCallback(
    (shouldWrite: (folder: string) => boolean) => {
      const write = source.setFolderName
      if (write === undefined) return
      for (const [path, name] of pending) {
        if (!shouldWrite(path) || writing.current.has(path)) continue
        writing.current.add(path)
        setRefusal(null)
        void write(path, name)
          .then(reload, (err: unknown) => setRefusal(refusalMessage(err)))
          .finally(() => {
            writing.current.delete(path)
            setPending((current) => withEntry(current, path, undefined))
          })
      }
    },
    [pending, source, reload],
  )

  useEffect(() => {
    flush((path) => standing.includes(path))
  }, [flush, standing])

  const flushInto = useCallback(
    (documentPath: string) => flush((path) => isSelfOrDescendant(documentPath, path)),
    [flush],
  )

  const remember = useCallback((path: string, name: string) => {
    setPending((current) => withEntry(current, path, name))
  }, [])

  const dismissRefusal = useCallback(() => setRefusal(null), [])
  return { pending, remember, flushInto, refusal, dismissRefusal }
}

/**
 * A named folder the last listing emptied keeps its name as a pending one.
 * The keeper prunes a folder's name with the folder, so without this a
 * document moved out and back would bring the folder back under its bare
 * segment. Read from the stored names of the render BEFORE the re-read
 * lands, which still hold the departed folder's.
 */
function useKeepEmptiedNames(
  source: WorkspaceFilesSource,
  documents: readonly WorkspaceDocumentEntry[] | null,
  standing: readonly string[],
  stored: FolderNames,
  remember: (path: string, name: string) => void,
) {
  const before = useRef<{ source: WorkspaceFilesSource; standing: readonly string[] } | null>(null)
  useEffect(() => {
    const previous = before.current
    before.current = documents === null ? null : { source, standing }
    if (previous === null || documents === null || previous.source !== source) return
    for (const path of previous.standing) {
      const name = stored.get(path)
      if (name !== undefined && !standing.includes(path)) remember(path, name)
    }
  }, [source, documents, standing, stored, remember])
}

/**
 * Folder display names: what the keeper lists, plus the names given to folders
 * that do not exist yet.
 *
 * A folder exists only while a document is in it, so an empty named folder is
 * not stored — its name is held HERE and written once the listing shows a
 * document under it. Until then the name still shows, which is what lets a
 * new subfolder be opened under the name it was given.
 */
export function useFolderNames(
  source: WorkspaceFilesSource,
  documents: readonly WorkspaceDocumentEntry[] | null,
): FolderNamesState {
  const { stored, reload } = useStoredFolderNames(source, documents)
  const standing = useMemo(() => foldersOf(documents ?? []), [documents])
  const { pending, remember, flushInto, refusal, dismissRefusal } = usePendingFolderNames(
    source,
    standing,
    reload,
  )

  useKeepEmptiedNames(source, documents, standing, stored, remember)

  const names = useMemo(() => new Map([...stored, ...pending]), [stored, pending])
  const folders = useMemo(() => [...new Set([...standing, ...pending.keys()])], [standing, pending])

  const rename = useCallback(
    async (path: string, name: string) => {
      if (!standing.includes(path)) {
        remember(path, name)
        return
      }
      await source.setFolderName?.(path, name)
      await reload()
    },
    [standing, source, reload, remember],
  )

  const canRename = useCallback(
    (path: string) =>
      path !== '' &&
      source.setFolderName !== undefined &&
      !(documents ?? []).some((entry) => entry.path === path),
    [source, documents],
  )

  return { names, folders, remember, flushInto, refusal, dismissRefusal, rename, canRename }
}
