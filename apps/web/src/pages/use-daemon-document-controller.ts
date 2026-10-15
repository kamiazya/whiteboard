import type {
  DocumentSummary,
  WorkspaceSummary,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { readWorkspaceNodes } from '@kamiazya/whiteboard-loro-adapter'
import { messageOf } from '@kamiazya/whiteboard-model'
import { useCallback, useEffect, useRef, useState } from 'react'
import { getAppLogger } from '../lib/app-logger.js'
import {
  createDocument as createDocumentApi,
  deleteDocument as deleteDocumentApi,
  duplicateDocument as duplicateDocumentApi,
  listDocuments,
  listWorkspaces as listWorkspacesApi,
} from '../lib/daemon-api-client.js'
import { type MembershipRefusalState, membershipRefusal } from '../lib/membership-refusal.js'

// `app-logger` takes (message, data) — the opposite order to the server's pino seam.
const log = getAppLogger('daemon-document-page')

export interface UseDaemonDocumentControllerOptions {
  daemonBaseUrl: string
  // Absent workspaceId/path is resolved to a default (first workspace / first
  // canvas) on mount — see the resolve effect below.
  workspaceId?: string
  path?: string
  daemonFetch: typeof fetch
}

export interface DaemonDocumentController {
  loading: boolean
  // Fatal: the initial mount resolution never produced a usable
  // workspace/canvas, so there is nothing on screen to fall back to. The page
  // renders this as a full-page error state.
  loadError: string | null
  // Set only once listDocuments has SUCCEEDED — never while a retry is in
  // flight, and never for a refused workspace. That admission gate is what
  // keeps the push/refresh effect (keyed on this field) off a workspace that
  // turns out to be refused.
  workspaceId: string | null
  path: string | null
  workspaces: WorkspaceSummary[]
  documents: DocumentSummary[]
  switchDocument: (path: string) => void
  createDocument: (path: string) => Promise<void>
  /**
   * Copy the document on screen and FOLLOW the copy.
   *
   * Rejects rather than holding its own error, unlike `createDocument` above:
   * the page owns the refusal surface for this one, through the same
   * `useDuplicateDocument` the browser keeper uses — one hook, so the two
   * keepers cannot word the same refusal differently.
   */
  duplicateDocument: () => Promise<void>
  /**
   * Delete the document on screen and move to what is left.
   *
   * Rejects rather than holding its own error, for the reason
   * `duplicateDocument` does: the page owns the refusal surface. The list is
   * refreshed either way by the caller's dialog, since after a FAILURE the
   * daemon's state is unknown from here — the same reading the index page's
   * `refreshAfterDelete` is built on.
   */
  deleteDocument: () => Promise<void>
  createError: string | null
  /** A membership refusal the resolve could not get past (ADR-0041/0042),
   *  naming the workspace — known once listWorkspaces has resolved, even
   *  before `workspaceId` above is admitted. `null` once admitted. */
  refusal: MembershipRefusalState | null
  /** Re-runs the resolve. */
  retry: () => void
  /**
   * Re-reads the document list. What `useListFollowsRecord` calls when the
   * workspace record changes under the page; a failure keeps the last list.
   */
  refreshDocuments: () => void
}

const DAEMON_REQUEST_FAILED = 'The daemon request failed.'

/**
 * How a failed resolve is reported.
 *
 * A refusal names the workspace it refused, when one is known — the page can
 * then offer to ask for access rather than only reporting an error. Anything
 * else is a plain load failure.
 */
function reportResolveFailure(
  err: unknown,
  knownWorkspaceId: string | null,
  setRefusal: (refusal: MembershipRefusalState) => void,
  setLoadError: (message: string) => void,
): void {
  const code = membershipRefusal(err)
  if (code !== null && knownWorkspaceId !== null) {
    setRefusal({ code, workspaceId: knownWorkspaceId })
    return
  }
  setLoadError(messageOf(err, DAEMON_REQUEST_FAILED))
}

/**
 * Resolves workspace/canvas defaults and owns the canvas-switcher list state
 * for DaemonDocumentPage. Deliberately does NOT create or own the
 * DocumentBackend/useDocumentSync connection — that stays in the page component,
 * mirroring BrowserDocumentPage's own useMemo(backend, [documentId]) plus
 * useDocumentSync ownership split.
 */
export function useDaemonDocumentController(
  options: UseDaemonDocumentControllerOptions,
): DaemonDocumentController {
  const { daemonBaseUrl, daemonFetch } = options
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [path, setPath] = useState<string | null>(options.path ?? null)
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<MembershipRefusalState | null>(null)

  // Monotonic sequence over the mount resolution, so a slower earlier
  // resolution can never clobber a later, already-committed selection. It was
  // shared with an in-page workspace switch until the shell became the one
  // switcher; what remains is the mount path alone.
  const resolveSeqRef = useRef(0)
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => {
    setRefusal(null)
    // Back to loading for the duration of the re-resolve — without this,
    // `loading` is already false from the failed attempt, and a caller
    // awaiting it settle would read the STALE false before the retry's own
    // resolve has even started.
    setLoading(true)
    setAttempt((n) => n + 1)
  }, [])

  // Resolution runs once per mount and once per retry() (daemonBaseUrl/
  // workspaceId/path are stable for the lifetime of this page).
  // listWorkspaces always runs, even when workspaceId is supplied, so the
  // switcher has a list to show — the real caller always passes a non-null
  // workspaceId, so gating this fetch behind wid===null would leave it dead
  // code.
  useEffect(() => {
    let cancelled = false
    const seq = resolveSeqRef.current
    // Still on screen AND still the latest resolve. A retry bumps the
    // generation, so an earlier resolve settling later must not commit over
    // it — the two halves always travel together, and writing them out at
    // each of the four commit points is the conjunction saying one thing.
    const current = () => !cancelled && seq === resolveSeqRef.current
    // Known once listWorkspaces resolves — closed over by resolveOnce so a
    // refusal from listDocuments can still name the workspace it refused,
    // even though `workspaceId` state itself is not admitted yet.
    let knownWid: string | null = null

    async function resolveOnce(): Promise<void> {
      const { workspaces: list } = await listWorkspacesApi(daemonFetch, daemonBaseUrl)
      if (!current()) return
      setWorkspaces(list)

      const wid = options.workspaceId ?? list[0]?.workspaceId ?? null
      if (wid === null) {
        setLoadError('No workspace is available on this daemon.')
        return
      }
      knownWid = wid

      const { documents } = await listDocuments(daemonFetch, daemonBaseUrl, wid)
      if (!current()) return
      // Admitted only now, together — never before listDocuments succeeds.
      // Setting workspaceId earlier would arm the page's replica push/refresh
      // effect (keyed on it) for a workspace that turns out to be refused.
      setWorkspaceId(wid)
      setDocuments(documents)
      setPath(options.path ?? documents[0]?.path ?? null)
    }

    async function resolve(): Promise<void> {
      try {
        await resolveOnce()
      } catch (err) {
        if (!current()) return
        reportResolveFailure(err, knownWid, setRefusal, setLoadError)
      } finally {
        if (current()) setLoading(false)
      }
    }

    void resolve()
    return () => {
      cancelled = true
    }
    // daemonFetch/options are stable for the page's lifetime (App.tsx only
    // mounts DaemonDocumentPage once per daemon connection); `attempt` is the only
    // real dependency, bumped by retry().
  }, [attempt])

  const relist = useDocumentListReader(daemonFetch, daemonBaseUrl, setDocuments)
  const refreshDocuments = useCallback(() => {
    if (workspaceId === null) return
    relist(workspaceId).catch((err: unknown) => log.warn('listDocuments failed', { err }))
  }, [relist, workspaceId])

  const switchDocument = useCallback((nextPath: string) => {
    setPath(nextPath)
  }, [])

  const createDocument = useCallback(
    async (newPath: string): Promise<void> => {
      if (workspaceId === null) return
      setCreateError(null)
      try {
        // What the legacy route defaulted this to; the affordance says canvas.
        const created = await createDocumentApi(
          daemonFetch,
          daemonBaseUrl,
          workspaceId,
          newPath,
          'spatial',
        )
        await relist(workspaceId)
        setPath(created.path)
      } catch (err) {
        setCreateError(messageOf(err, DAEMON_REQUEST_FAILED))
        // The caller derives its next path from `documents`. A failure often means that list is
        // already stale (another client took the path) — without a refresh, a retry re-derives
        // the SAME losing path from the same stale list and collides forever. Best-effort:
        // leaving the previous (possibly stale) list is no worse than not trying.
        await relist(workspaceId).catch(() => {})
      }
    },
    [daemonFetch, daemonBaseUrl, workspaceId, relist],
  )

  const duplicateDocument = useCallback(async (): Promise<void> => {
    if (workspaceId === null || path === null) {
      throw new Error('No document is open to duplicate.')
    }
    const { document: copy } = await duplicateDocumentApi(
      daemonFetch,
      daemonBaseUrl,
      workspaceId,
      path,
    )
    // Same two steps `createDocument` ends with, and the same order: the list
    // is refreshed BEFORE the path moves, so the page never points at a
    // document its own switcher does not hold yet.
    await relist(workspaceId)
    setPath(copy.path)
  }, [daemonFetch, daemonBaseUrl, workspaceId, path, relist])

  const deleteDocument = useCallback(async (): Promise<void> => {
    if (workspaceId === null || path === null) {
      throw new Error('No document is open to delete.')
    }
    await deleteDocumentApi(daemonFetch, daemonBaseUrl, workspaceId, path)
    const refreshed = await relist(workspaceId)
    // Whatever is left, or nothing — the page's empty state is what answers
    // an emptied workspace, and it already does (`replaceEditor`).
    setPath(refreshed[0]?.path ?? null)
  }, [daemonFetch, daemonBaseUrl, workspaceId, path, relist])

  return {
    loading,
    loadError,
    workspaceId,
    path,
    workspaces,
    documents,
    switchDocument,
    createDocument,
    duplicateDocument,
    deleteDocument,
    createError,
    refusal,
    retry,
    refreshDocuments,
  }
}

/**
 * Every read of the list after the mount resolve, behind one generation: a
 * slower earlier read never commits over a later one, and nothing commits
 * once the page is gone. The FETCHED list is answered either way, since a
 * caller that just deleted needs it to pick what to show next; only the
 * newest read is what the page holds.
 */
function useDocumentListReader(
  daemonFetch: typeof fetch,
  daemonBaseUrl: string,
  setDocuments: (documents: DocumentSummary[]) => void,
): (workspaceId: string) => Promise<DocumentSummary[]> {
  const generationRef = useRef(0)
  useEffect(
    () => () => {
      generationRef.current += 1
    },
    [],
  )
  return useCallback(
    async (workspaceId: string) => {
      const generation = ++generationRef.current
      const { documents } = await listDocuments(daemonFetch, daemonBaseUrl, workspaceId)
      if (generation === generationRef.current) setDocuments(documents)
      return documents
    },
    [daemonFetch, daemonBaseUrl, setDocuments],
  )
}

/** How long a burst of remote updates settles before the record is compared. */
const LIST_FOLLOW_SETTLE_MS = 250

/** What the list shows of each document the record holds, as one comparable value. */
/** The workspace record, named through the adapter so pages never import the CRDT. */
type WorkspaceRecord = Parameters<typeof readWorkspaceNodes>[0]

function listedShapeOf(record: WorkspaceRecord): string {
  const rows = readWorkspaceNodes(record).flatMap((node) =>
    node.type === 'document'
      ? [[node.meta.documentId, node.path, node.meta.kind, node.meta.name, node.meta.updatedAt]]
      : [],
  )
  return JSON.stringify(rows)
}

/**
 * Keeps the page's document list following the workspace record it syncs.
 *
 * A document created, renamed, moved, deleted or edited elsewhere — an
 * agent's write, another tab's, another member's — arrives as an import into
 * that record and nowhere else; the list every link, reference and embed on
 * the page resolves against is a separate read, so without this it stays as
 * it was at open. Only an import that changes what the list SHOWS re-reads it,
 * compared after a settle window so a burst of updates costs one walk and one
 * read. A record replaced by a reconnect snapshot is compared against the one
 * before it, since what it carries may have been missed while disconnected.
 *
 * Takes the session's body binding because its `doc` IS the live record, and
 * a new binding is exactly a snapshot that replaced it.
 */
export function useListFollowsRecord(
  binding: { readonly doc: WorkspaceRecord } | null,
  refresh: () => void,
): void {
  const record = binding?.doc ?? null
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const shapeRef = useRef<string | null>(null)
  useEffect(() => {
    if (record === null) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const compare = () => {
      const shape = listedShapeOf(record)
      const moved = shapeRef.current !== null && shape !== shapeRef.current
      shapeRef.current = shape
      if (moved) refreshRef.current()
    }
    const settle = () => {
      clearTimeout(timer)
      timer = setTimeout(compare, LIST_FOLLOW_SETTLE_MS)
    }
    if (shapeRef.current === null) compare()
    else settle()
    const unsubscribe = record.subscribe((event) => {
      if (event.by === 'import') settle()
    })
    return () => {
      unsubscribe()
      clearTimeout(timer)
    }
  }, [record])
}
