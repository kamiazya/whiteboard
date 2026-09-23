/**
 * The daemon's half of the Connections chip: its backlinks route, handed to
 * the keeper-agnostic `useConnections`. The browser's half is
 * `use-browser-connections.ts`.
 */
import { useMemo } from 'react'
import { getDocumentBacklinks } from '../lib/daemon-api-client.js'
import { type Connections, type UseConnectionsResult, useConnections } from './use-connections.js'

export type DaemonConnections = Connections

export interface UseDaemonConnectionsOptions {
  readonly daemonFetch: typeof globalThis.fetch
  readonly daemonBaseUrl: string
  readonly workspaceId: string | null
  /**
   * Undefined while the list holds no row for the current path — a refresh in
   * flight, or a document just created. NOT an id-less row: `id` is required
   * by `documentSummarySchema`, so a summary without one does not parse and
   * never reaches here. The chip stays disabled rather than querying with a
   * path the route would reject.
   */
  readonly documentId: string | undefined
  /** The screen's scope: a change clears what is shown before the fetch runs. */
  readonly path: string | null
}

export function useDaemonConnections({
  daemonFetch,
  daemonBaseUrl,
  workspaceId,
  documentId,
  path,
}: UseDaemonConnectionsOptions): UseConnectionsResult {
  const read = useMemo(
    () =>
      workspaceId === null
        ? null
        : (id: string) => getDocumentBacklinks(daemonFetch, daemonBaseUrl, workspaceId, id),
    [daemonFetch, daemonBaseUrl, workspaceId],
  )
  return useConnections({ read, documentId, path })
}
