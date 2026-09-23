/**
 * The browser's half of the Connections chip: its own reference graph,
 * handed to the keeper-agnostic `useConnections`, and the panel's **Link**
 * over this browser's own documents. The daemon's half is
 * `use-daemon-connections.ts`.
 */
import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import { useCallback, useMemo } from 'react'
import type { ConnectionsBacklink } from '../components/connections/ConnectionsPanel.js'
import { browserBacklinksReader } from '../lib/browser-backlinks.js'
import { linkifyBrowserMentions } from '../lib/browser-linkify.js'
import type { LoroStoreLike } from '../lib/loro-store.js'
import { type UseConnectionsResult, useConnections } from './use-connections.js'

export function useBrowserConnections({
  index,
  loro,
  documentId,
  path,
}: {
  readonly index: DocumentIndex
  readonly loro: LoroStoreLike
  readonly documentId: string | undefined
  readonly path: string | null
}): UseConnectionsResult & {
  /** Turn one mention row's occurrences into links to the open document. */
  readonly linkify: (mention: ConnectionsBacklink) => void
} {
  // One reader — and so one facts cache — for as long as the page keeps its
  // index and store, which is across every document it switches between.
  const read = useMemo(() => browserBacklinksReader(index, loro), [index, loro])
  const connections = useConnections({ read, documentId, path })
  const { refresh } = connections
  // A failed link is swallowed on purpose, as on the daemon: the panel keeps
  // showing the mention, and the next open retries. The re-read after a
  // success is what moves the row from mentions to backlinks — the source's
  // content digest moved, so the cache reads it again.
  const linkify = useCallback(
    (mention: ConnectionsBacklink) => {
      if (documentId === undefined) return
      void linkifyBrowserMentions(index, mention.documentId, documentId)
        .then(() => refresh())
        .catch(() => {})
    },
    [index, documentId, refresh],
  )
  return { ...connections, linkify }
}
