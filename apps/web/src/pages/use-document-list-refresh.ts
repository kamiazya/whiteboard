/**
 * The workspace's document list, kept current beside the document on screen.
 *
 * Enumeration is a Promise, not reactive state, so it is refreshed whenever
 * the current document's identity or its own `updatedAt` changes — which
 * covers a switch, a create-then-switch, and an edit to the current row
 * reflecting in the list. The generation guard drops a stale resolution that
 * would otherwise clobber a newer refresh triggered by a fast switch.
 *
 * `enumeratedRef` is returned rather than kept by the caller because this is
 * what WRITES it. The URL -> document effect reads it to tell "this path does
 * not exist" from "the list has not arrived", which look identical in
 * `switcherOptions`; a ref rather than state because that effect reads it
 * inside a callback, where state would answer with the render it closed over.
 */
import { type RefObject, useEffect, useRef, useState } from 'react'
import { getAppLogger } from '../lib/app-logger.js'
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

export function useDocumentListRefresh(options: {
  /** The document on screen, or null while none is loaded. */
  readonly documentId: string | null
  /** Its own `updatedAt`, so an edit to the current row reaches the list. */
  readonly currentUpdatedAt: string | null
  readonly listDocuments: () => Promise<DocumentSnapshot[]>
}): DocumentListRefresh {
  const { documentId, currentUpdatedAt, listDocuments } = options
  const [documents, setDocuments] = useState<DocumentSnapshot[]>([])
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
        // A stale/failed list refresh must not surface as an unhandled
        // rejection; the switcher just keeps showing its last-known list.
        log.error('listDocuments failed', err)
      })
  }, [documentId, currentUpdatedAt, listDocuments])

  return { documents, enumeratedRef }
}
