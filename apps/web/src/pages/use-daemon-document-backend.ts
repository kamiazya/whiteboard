/**
 * WHICH connection this daemon page syncs through, and the one piece of state
 * that belongs to a connection rather than to the page: whether the daemon
 * refused it.
 *
 * Extracted from `DaemonDocumentPage`'s own hook (audit-triage 2026-09-21,
 * item 6 slice 4) along the seam its closures already drew: everything here
 * reads the pairing payload and the controller's resolved (workspace, path,
 * documents) and nothing else, and nothing outside reads its parts
 * separately — `contentDocumentId` travels with the backend because they
 * only make sense together, and `authError` resets on a new backend.
 */

import type { DocumentSummary } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { DaemonBackend } from '@kamiazya/whiteboard-daemon-client/daemon-backend'
import type { DocumentBackend } from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import { selectDocumentTransport } from '@kamiazya/whiteboard-daemon-client/select-document-transport'
import { SseBackend } from '@kamiazya/whiteboard-daemon-client/sse-backend'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { devTransportOverride } from '../lib/dev-transport-override.js'
import { createSharedSseStreamSource } from '../lib/sse-shared-stream-source.js'

/** What a parent may substitute for the connection this hook would build. */
export type CreateDaemonBackend = (
  workspaceId: string,
  path: string,
  fetch: typeof globalThis.fetch,
) => DocumentBackend | null | undefined

export interface DaemonDocumentBackendOptions {
  readonly daemonBaseUrl: string
  readonly token: string | undefined
  readonly daemonFetch: typeof globalThis.fetch
  readonly createBackend?: CreateDaemonBackend
  /** The controller's resolved selection; either half null means no connection. */
  readonly workspaceId: string | null
  readonly path: string | null
  /** While the list is still loading, no backend — see the memo's own note. */
  readonly loading: boolean
  readonly documents: readonly DocumentSummary[]
  /** Served by a server-mode keeper, which has no WebSocket (ADR-0047). */
  readonly serverMode?: boolean
}

export interface DaemonDocumentBackendState {
  readonly backend: DocumentBackend | null
  readonly contentDocumentId: string | undefined
  /** Whether the daemon refused THIS connection's session. */
  readonly authError: boolean
  readonly reportAuthError: () => void
}

interface DaemonConnection {
  readonly workspaceId: string
  readonly path: string
  readonly daemonBaseUrl: string
  readonly daemonFetch: typeof globalThis.fetch
  readonly token: string | undefined
  readonly serverMode: boolean
  readonly contentDocumentId: string
}

function connectDaemonDocument({
  workspaceId,
  path,
  daemonBaseUrl,
  daemonFetch,
  token,
  serverMode,
  contentDocumentId,
}: DaemonConnection): { backend: DocumentBackend; contentDocumentId: string } {
  // A secure page cannot open a ws:// socket to an http daemon at all, so
  // the transport is decided up front rather than attempted and retried.
  //
  // The override in front is development-only and compiles away entirely
  // in a production build. It exists because the rule below is correct AND
  // makes the SSE path — and the SharedWorker behind it — unreachable from
  // `pnpm dev`, which serves plain http.
  const transport =
    devTransportOverride() ??
    selectDocumentTransport({
      pageOrigin: window.location.origin,
      daemonBaseUrl,
      keeperServesWebSocket: !serverMode,
    })
  if (transport !== 'sse') {
    // wsToken carries the pairing session token into the WS upgrade —
    // without it a pairing-grant session authenticates HTTP but opens
    // the socket credential-less and is rejected 401 (edits then stay
    // browser-only while the page looks connected).
    return {
      backend: new DaemonBackend(workspaceId, path, daemonBaseUrl, {
        fetch: daemonFetch,
        wsToken: () => token,
      }),
      contentDocumentId: contentDocumentId,
    }
  }
  // Null where SharedWorker is unavailable; SseBackend then opens its own
  // stream, which is correct but not shared across tabs. Same granularity
  // as the WebSocket branch: every document syncs at workspace-document
  // granularity.
  const shared = createSharedSseStreamSource(daemonBaseUrl, token) ?? undefined
  return {
    backend: new SseBackend(workspaceId, path, daemonBaseUrl, { fetch: daemonFetch }, shared),
    contentDocumentId: contentDocumentId,
  }
}

export function useDaemonDocumentBackend({
  daemonBaseUrl,
  token,
  daemonFetch,
  createBackend,
  workspaceId,
  path,
  loading,
  documents,
  serverMode = false,
}: DaemonDocumentBackendOptions): DaemonDocumentBackendState {
  const [authError, setAuthError] = useState(false)

  // The injected factory is held in a ref rather than carried in the backend
  // memo's dependencies: it customises HOW a connection is built, it does not
  // say WHICH connection this is. A parent writing the natural
  // `createBackend={(w, s) => …}` hands this page a new function identity on
  // every one of its own renders, and anything the backend memo depends on
  // becomes the session's lifetime — so that alone would tear down the
  // socket, re-hydrate, and drop the undo history for a canvas the user
  // never left. Only values that define the connection belong in those deps.
  const createBackendRef = useRef(createBackend)
  createBackendRef.current = createBackend

  // Every listed document is tree-served and syncs at workspace-document
  // granularity; the id is what binds this session's content inside the
  // workspace record. Derived as a plain string so a summary refresh that
  // changes only updatedAt cannot flip the backend identity. Undefined only
  // while the path is absent from the list (a stale URL).
  const workspaceSyncDocumentId = useMemo(() => {
    const entry = documents.find((d) => d.path === path)
    return entry?.id
  }, [documents, path])

  // Backend identity is keyed on (workspaceId, path, daemonFetch, sync
  // granularity) — a change to any of these tears down the old connection and
  // opens a new one via useDocumentSync's own effect cleanup (see
  // BrowserDocumentPage for the same ownership split: this hook only decides
  // WHEN to swap identity, not how disconnect/connect ordering happens).
  // `contentDocumentId` travels WITH the backend because they only make sense
  // together: an injected backend (tests, embedders) keeps the per-document
  // contract, so scoping the session against its snapshot would misread it.
  const backendState = useMemo((): {
    backend: DocumentBackend
    contentDocumentId: string | undefined
  } | null => {
    if (workspaceId === null || path === null) return null
    // No backend until the initial documents list is in: the page renders a
    // skeleton anyway, and the list is what decides the sync granularity —
    // connecting before it loads would open a per-document socket only to
    // tear it down and reconnect at workspace scope a moment later.
    if (loading) return null
    const injected = createBackendRef.current?.(workspaceId, path, daemonFetch)
    if (injected) return { backend: injected, contentDocumentId: undefined }
    // Nothing is at this path (a stale URL — the document was deleted or
    // never existed): no connection. The per-document contract used to catch
    // this with a lazily created empty doc, which silently minted a blank
    // canvas at the old path on the first edit; creating a document is an
    // explicit act now (see the not-found state below).
    if (workspaceSyncDocumentId === undefined) return null
    return connectDaemonDocument({
      workspaceId,
      path,
      daemonBaseUrl,
      daemonFetch,
      token,
      serverMode,
      contentDocumentId: workspaceSyncDocumentId,
    })
  }, [
    workspaceId,
    path,
    loading,
    daemonFetch,
    daemonBaseUrl,
    token,
    workspaceSyncDocumentId,
    serverMode,
  ])
  const backend = backendState?.backend ?? null

  // A rejected session belongs to one backend identity — switching to a new
  // canvas opens a fresh connection, so a stale banner must not outlive the
  // backend that produced it. Only resets on a genuine new (non-null)
  // connection: dropping to no backend at all (e.g. switching into a
  // workspace with zero documents) leaves authError as-is, because live sync
  // is still off either way and the persistent indicator should stay lit.
  useEffect(() => {
    if (backend) setAuthError(false)
  }, [backend])

  const reportAuthError = useCallback(() => {
    setAuthError(true)
  }, [])

  return {
    backend,
    contentDocumentId: backendState?.contentDocumentId,
    authError,
    reportAuthError,
  }
}
