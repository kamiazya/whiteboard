import type {
  DocumentSummary,
  WorkspaceSummary,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createDocument as createCanvasApi,
  listDocuments,
  listWorkspaces as listWorkspacesApi,
} from '../lib/daemon-api-client.js'
import {
  type MembershipRefusalState,
  membershipRefusal,
  withOnePasskeyBind,
} from '../lib/membership-refusal.js'
import { passkeySupported } from '../lib/passkey-attestation.js'
import { bindPasskeySession } from '../lib/passkey-session.js'

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
  // Set only once listDocuments has SUCCEEDED — never while a bind/retry is
  // in flight, and never for a refused workspace. That admission gate is
  // what keeps the push/refresh effect (keyed on this field) from racing the
  // resolve's own passkey bind with a second one of its own.
  workspaceId: string | null
  path: string | null
  workspaces: WorkspaceSummary[]
  documents: DocumentSummary[]
  switchDocument: (path: string) => void
  createDocument: (path: string) => Promise<void>
  createError: string | null
  /** A membership refusal the resolve could not get past (ADR-0041/0042 S8),
   *  naming the workspace — known once listWorkspaces has resolved, even
   *  before `workspaceId` above is admitted. `null` once admitted. */
  refusal: MembershipRefusalState | null
  /** Re-runs the resolve, resetting the once-only passkey-bind guard so it
   *  may bind exactly one more time. */
  retry: () => void
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'The daemon request failed.'
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
  // One bind per (daemon, page) mount — reset by retry() so a refusal that
  // survives a bind can be answered by exactly one more prompt, never a loop.
  const bindGuardRef = useRef({ attempted: false })

  const retry = useCallback(() => {
    bindGuardRef.current = { attempted: false }
    setRefusal(null)
    // Back to loading for the duration of the re-resolve — without this,
    // `loading` is already false from the failed attempt, and a caller
    // awaiting it settle would read the STALE false before the retry's own
    // resolve has even started.
    setLoading(true)
    setAttempt((n) => n + 1)
  }, [])

  // Resolution runs once per mount and once per retry() (daemonBaseUrl/
  // workspaceId/path come from a stable pairing payload for the lifetime of
  // this page). listWorkspaces always runs, even when workspaceId is
  // supplied, so the switcher has a list to show — the real pairing-payload
  // caller always passes a non-null workspaceId, so gating this fetch behind
  // wid===null left it dead code.
  useEffect(() => {
    let cancelled = false
    const seq = resolveSeqRef.current
    // Known once listWorkspaces resolves — closed over by resolveOnce so a
    // refusal from listDocuments can still name the workspace it refused,
    // even though `workspaceId` state itself is not admitted yet.
    let knownWid: string | null = null

    async function resolveOnce(): Promise<void> {
      const { workspaces: list } = await listWorkspacesApi(daemonFetch, daemonBaseUrl)
      if (cancelled || seq !== resolveSeqRef.current) return
      setWorkspaces(list)

      const wid = options.workspaceId ?? list[0]?.workspaceId ?? null
      if (wid === null) {
        setLoadError('No workspace is available on this daemon.')
        return
      }
      knownWid = wid

      const { documents } = await listDocuments(daemonFetch, daemonBaseUrl, wid)
      if (cancelled || seq !== resolveSeqRef.current) return
      // Admitted only now, together — never before listDocuments succeeds.
      // Setting workspaceId earlier would arm the page's replica push/refresh
      // effect (keyed on it) for a workspace that turns out to be refused,
      // and would let that effect's own passkey bind race this one.
      setWorkspaceId(wid)
      setDocuments(documents)
      setPath(options.path ?? documents[0]?.path ?? null)
    }

    async function resolve(): Promise<void> {
      try {
        await withOnePasskeyBind(
          resolveOnce,
          () =>
            bindPasskeySession({
              daemonBaseUrl,
              fetch: daemonFetch,
              credentials: passkeySupported() ? globalThis.navigator?.credentials : undefined,
            }),
          bindGuardRef.current,
        )
      } catch (err) {
        if (cancelled || seq !== resolveSeqRef.current) return
        const code = membershipRefusal(err)
        if (code !== null && knownWid !== null) {
          setRefusal({ code, workspaceId: knownWid })
        } else {
          setLoadError(errorMessage(err))
        }
      } finally {
        if (!cancelled && seq === resolveSeqRef.current) setLoading(false)
      }
    }

    void resolve()
    return () => {
      cancelled = true
    }
    // daemonFetch/options are stable for the page's lifetime (App.tsx only
    // mounts DaemonDocumentPage once per pairing); `attempt` is the only
    // real dependency, bumped by retry().
  }, [attempt])

  const switchDocument = useCallback((nextPath: string) => {
    setPath(nextPath)
  }, [])

  const createDocument = useCallback(
    async (newPath: string): Promise<void> => {
      if (workspaceId === null) return
      setCreateError(null)
      try {
        const created = await createCanvasApi(daemonFetch, daemonBaseUrl, workspaceId, newPath)
        const { documents: refreshed } = await listDocuments(
          daemonFetch,
          daemonBaseUrl,
          workspaceId,
        )
        setDocuments(refreshed)
        setPath(created.path)
      } catch (err) {
        setCreateError(errorMessage(err))
        // The caller derives its next path from `documents`. A failure often means that list is
        // already stale (another client took the path) — without a refresh, a retry re-derives
        // the SAME losing path from the same stale list and collides forever. Best-effort:
        // leaving the previous (possibly stale) list is no worse than not trying.
        await listDocuments(daemonFetch, daemonBaseUrl, workspaceId)
          .then(({ documents: refreshed }) => setDocuments(refreshed))
          .catch(() => {})
      }
    },
    [daemonFetch, daemonBaseUrl, workspaceId],
  )

  return {
    loading,
    loadError,
    workspaceId,
    path,
    workspaces,
    documents,
    switchDocument,
    createDocument,
    createError,
    refusal,
    retry,
  }
}
