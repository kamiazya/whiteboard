/**
 * The browser's half of the Connections chip: its own reference graph,
 * handed to the keeper-agnostic `useConnections`. The daemon's half is
 * `use-daemon-connections.ts`.
 */
import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import { useMemo } from 'react'
import { browserBacklinksReader } from '../lib/browser-backlinks.js'
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
}): UseConnectionsResult {
  // One reader — and so one facts cache — for as long as the page keeps its
  // index and store, which is across every document it switches between.
  const read = useMemo(() => browserBacklinksReader(index, loro), [index, loro])
  return useConnections({ read, documentId, path })
}
