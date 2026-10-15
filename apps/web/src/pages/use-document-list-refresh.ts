/**
 * The workspace's document list, kept current beside the document on screen.
 *
 * Enumeration is a Promise, not reactive state, so it is refreshed whenever
 * the current document's identity or its own `updatedAt` changes — which
 * covers a switch, a create-then-switch, and an edit to the current row
 * reflecting in the list — and whenever the workspace's channel says the
 * record changed. That last one is what follows another tab: its create,
 * rename or move is written by its index and announced by name, so no bytes
 * reach the record this page syncs and nothing else here would move. The
 * generation guard drops a stale resolution that would otherwise clobber a
 * newer refresh triggered by a fast switch.
 *
 * `enumeratedRef` is returned rather than kept by the caller because this is
 * what WRITES it. The URL -> document effect reads it to tell "this path does
 * not exist" from "the list has not arrived", which look identical in
 * `switcherOptions`; a ref rather than state because that effect reads it
 * inside a callback, where state would answer with the render it closed over.
 */
import { type RefObject, useEffect, useRef, useState } from 'react'
import { getAppLogger } from '../lib/app-logger.js'
import { followBrowserWorkspaceWrites } from '../lib/follow-workspace-writes.js'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'

// The page's own scope, deliberately: this is that screen's list, and a
// record that moved scope when the code moved file would read as a new
// failure. `app-logger` takes (message, data) — the opposite order to the
// server's pino seam.
const log = getAppLogger('browser-document-page')

export interface DocumentListRefresh {
  readonly documents: DocumentSnapshot[]
  readonly enumeratedRef: RefObject<boolean>
}

/** A count that moves each time the workspace's channel says its record changed. */
function useWorkspaceRevision(workspaceId: string | null): number {
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (workspaceId === null) return
    return followBrowserWorkspaceWrites(workspaceId, {
      onMoved: () => setRevision((n) => n + 1),
      // The record leaving this browser is the sync session's to answer: it
      // locks the page over a document that is gone, and a re-read here would
      // only meet the registry's refusal.
      onRemoved: () => {},
    })
  }, [workspaceId])
  return revision
}

export function useDocumentListRefresh(options: {
  /** The document on screen, or null while none is loaded. */
  readonly documentId: string | null
  /** Its own `updatedAt`, so an edit to the current row reaches the list. */
  readonly currentUpdatedAt: string | null
  readonly listDocuments: () => Promise<DocumentSnapshot[]>
  /** The workspace whose channel is followed, or null while none is resolved. */
  readonly workspaceId: string | null
}): DocumentListRefresh {
  const { documentId, currentUpdatedAt, listDocuments, workspaceId } = options
  const [documents, setDocuments] = useState<DocumentSnapshot[]>([])
  const workspaceRevision = useWorkspaceRevision(workspaceId)
  const generationRef = useRef(0)
  const enumeratedRef = useRef(false)

  useEffect(() => {
    if (documentId === null) return
    const generation = ++generationRef.current
    listDocuments()
      .then((list) => {
        if (generation !== generationRef.current) return
        enumeratedRef.current = true
        setDocuments(list)
      })
      .catch((err: unknown) => {
        // A failed list refresh must not surface as an unhandled rejection;
        // the switcher just keeps showing its last-known list. One nobody is
        // waiting on — superseded by a newer refresh, or the page
        // already gone — is not reported either: the record would be filed
        // against whatever is on screen by then.
        if (generation !== generationRef.current) return
        log.error('listDocuments failed', err)
      })
    return () => {
      generationRef.current += 1
    }
  }, [documentId, currentUpdatedAt, listDocuments, workspaceId, workspaceRevision])

  return { documents, enumeratedRef }
}
