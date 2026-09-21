/**
 * The Connections chip's backlinks for the document on screen.
 *
 * Daemon-only: backlinks come from the daemon's index, which the browser
 * keeper has no equivalent of, so there is no twin of this hook and nothing
 * for `keeper-parity.test.ts` to pair it with.
 *
 * It owns its own SCOPE RESET rather than leaving one line behind in the
 * page's. The fetch below nulls the value itself, but only once it knows the
 * ARRIVED document's id — which comes from a list that may still be
 * refreshing — so without the reset the departed document's connections are
 * listed under the arrived one until it does.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ConnectionsBacklink } from '../components/connections/ConnectionsPanel.js'
import { getDocumentBacklinks } from '../lib/daemon-api-client.js'

export interface DaemonConnections {
  readonly backlinks: readonly ConnectionsBacklink[]
  readonly unlinkedMentions: readonly ConnectionsBacklink[]
}

export interface UseDaemonConnectionsOptions {
  readonly daemonFetch: typeof globalThis.fetch
  readonly daemonBaseUrl: string
  readonly workspaceId: string | null
  /**
   * Undefined while the list has not named an id for the current path — an
   * older daemon's id-less listing leaves the chip disabled rather than
   * querying with a path the route would reject.
   */
  readonly documentId: string | undefined
  /** The screen's scope: a change clears what is shown before the fetch runs. */
  readonly path: string | null
}

export interface UseDaemonConnectionsResult {
  readonly connections: DaemonConnections | null
  /** Re-runs the fetch; the panel uses it after linkifying a mention. */
  readonly refresh: () => void
}

export function useDaemonConnections({
  daemonFetch,
  daemonBaseUrl,
  workspaceId,
  documentId,
  path,
}: UseDaemonConnectionsOptions): UseDaemonConnectionsResult {
  const [connections, setConnections] = useState<DaemonConnections | null>(null)
  const [connectionsRefresh, setConnectionsRefresh] = useState(0)

  // SCOPE RESET — see scoped-screen-state.test.ts.
  useEffect(() => {
    setConnections(null)
  }, [path])

  useEffect(() => {
    setConnections(null)
    if (documentId === undefined || workspaceId === null) return
    let cancelled = false
    getDocumentBacklinks(daemonFetch, daemonBaseUrl, workspaceId, documentId)
      .then((response) => {
        if (!cancelled) setConnections(response)
      })
      .catch(() => {
        // The chip simply stays disabled; connections are never worth an
        // error surface of their own on a page that otherwise works.
      })
    return () => {
      cancelled = true
    }
  }, [daemonFetch, daemonBaseUrl, workspaceId, documentId, connectionsRefresh])

  const refresh = useCallback(() => {
    setConnectionsRefresh((n) => n + 1)
  }, [])

  return { connections, refresh }
}
