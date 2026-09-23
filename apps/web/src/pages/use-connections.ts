/**
 * The Connections chip's backlinks for the document on screen — for EITHER
 * keeper. What differs between them is one function, `read`: the daemon asks
 * its route, the browser answers from its own reference graph. Everything
 * else here is about the SCREEN, and the screen is the same page on both.
 *
 * It owns its own SCOPE RESET rather than leaving one line behind in the
 * page's. The fetch below nulls the value itself, but only once it knows the
 * ARRIVED document's id — which comes from a list that may still be
 * refreshing — so without the reset the departed document's connections are
 * listed under the arrived one until it does.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionsBacklink } from '../components/connections/ConnectionsPanel.js'

export interface Connections {
  readonly backlinks: readonly ConnectionsBacklink[]
  readonly unlinkedMentions: readonly ConnectionsBacklink[]
}

export interface UseConnectionsOptions {
  /**
   * How this keeper answers for one document, or null while it cannot ask
   * yet (a daemon workspace still resolving). Keep it stable across renders:
   * a new function re-asks, which is also how a caller says "the answer may
   * have changed".
   */
  readonly read: ((documentId: string) => Promise<Connections>) | null
  /**
   * Undefined while the list holds no row for the current path — a refresh in
   * flight, or a document just created. The chip stays disabled rather than
   * asking about a document the keeper would not recognise.
   */
  readonly documentId: string | undefined
  /** The screen's scope: a change clears what is shown before the read runs. */
  readonly path: string | null
}

export interface UseConnectionsResult {
  readonly connections: Connections | null
  /** Re-runs the read; the panel uses it after linkifying a mention. */
  readonly refresh: () => void
}

export function useConnections({
  read,
  documentId,
  path,
}: UseConnectionsOptions): UseConnectionsResult {
  const [connections, setConnections] = useState<Connections | null>(null)
  const [connectionsRefresh, setConnectionsRefresh] = useState(0)
  // Which SCOPE a request was made in. `cancelled` below cannot carry this:
  // it is set by the read effect's own cleanup, which runs only when that
  // effect's deps change — and the path is not one of them, deliberately (see
  // the read effect). So a switch while the id still lags runs no cleanup,
  // and the in-flight answer would land AFTER the reset and refill the panel
  // it just cleared.
  const pathScope = useRef(0)

  // SCOPE RESET — see scoped-screen-state.test.ts.
  useEffect(() => {
    pathScope.current += 1
    setConnections(null)
  }, [path])

  // `connectionsRefresh` is read so a refresh re-runs the effect.
  useEffect(() => {
    void connectionsRefresh
    setConnections(null)
    if (documentId === undefined || read === null) return
    // NOT keyed on the path: after a switch the id lags, so re-running here
    // would re-read the DEPARTED document and show it under the arrived one.
    // The scope is checked at apply time instead.
    const requestedIn = pathScope.current
    let cancelled = false
    read(documentId)
      .then((answer) => {
        if (!cancelled && pathScope.current === requestedIn) setConnections(answer)
      })
      .catch(() => {
        // The chip simply stays disabled; connections are never worth an
        // error surface of their own on a page that otherwise works.
      })
    return () => {
      cancelled = true
    }
  }, [read, documentId, connectionsRefresh])

  const refresh = useCallback(() => {
    setConnectionsRefresh((n) => n + 1)
  }, [])

  return { connections, refresh }
}
