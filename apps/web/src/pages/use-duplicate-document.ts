/**
 * Duplicate-this-document, as the browser document page's own screen state.
 *
 * `duplicateDocument()` rejects on failure (see the controller hook) rather
 * than carrying its own error/pending state, so the PAGE owns both: a
 * disable-while-in-flight guard — a second click during the async
 * read-then-write must not start a second copy — and the error surface.
 *
 * Everything here NAMES A DOCUMENT, and the page keeps its own document
 * switching rather than remounting (App.tsx says so at the mount site), so
 * none of it may outlive the document it is about. SCOPE RESET — see
 * scoped-screen-state.test.ts, whose BrowserDocumentPage scan reads this
 * file too: the state moved HERE, not away.
 */
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { type RefObject, useEffect, useState } from 'react'
import { kindNoun } from '../lib/kind-noun.js'

export interface DuplicateDocumentState {
  readonly isDuplicating: boolean
  readonly duplicateError: string | null
  readonly handleDuplicate: () => Promise<void>
}

export interface UseDuplicateDocumentOptions {
  /** The document on screen, or null while none is loaded. */
  readonly documentId: string | null
  /**
   * Who is on screen NOW. An async handler that started under one document
   * has to ask this rather than its own closure, which can only answer with
   * the render it was created in.
   */
  readonly currentDocumentIdRef: RefObject<string | null>
  /** Only for the refusal's wording: "Failed to duplicate <noun>." */
  readonly documentKind: DocumentKind
  /** Resolves with the copy; this hook ignores it and watches only the refusal. */
  readonly duplicateDocument: () => Promise<unknown>
}

export function useDuplicateDocument({
  documentId,
  currentDocumentIdRef,
  documentKind,
  duplicateDocument,
}: UseDuplicateDocumentOptions): DuplicateDocumentState {
  const [isDuplicating, setIsDuplicating] = useState(false)
  const [duplicateError, setDuplicateError] = useState<string | null>(null)

  const handleDuplicate = async () => {
    if (isDuplicating) return
    // The document this run is about, fixed before the first await. The page
    // stays mounted across a switch, so by the time the catch below runs the
    // one on screen may be a different document.
    const startedOn = documentId
    setIsDuplicating(true)
    setDuplicateError(null)
    try {
      await duplicateDocument()
    } catch (err) {
      // Resetting on the switch is not enough on its own: this runs AFTER the
      // reset, so without the guard the failed duplicate of the document that
      // left prints its error under a document that has nothing wrong with
      // it. Same residual the save indicator had, same shape of fix.
      if (currentDocumentIdRef.current !== startedOn) return
      setDuplicateError(
        err instanceof Error ? err.message : `Failed to duplicate ${kindNoun(documentKind)}.`,
      )
    } finally {
      if (currentDocumentIdRef.current === startedOn) setIsDuplicating(false)
    }
  }

  // SCOPE RESET — both of these name the document the run was about, and the
  // page switches documents without remounting, so neither may outlive it.
  // Keyed on the same `documentId` the page's own reset effect watches; see
  // scoped-screen-state.test.ts, which reads this block by that marker.
  useEffect(() => {
    setDuplicateError(null)
    setIsDuplicating(false)
  }, [documentId])

  return { isDuplicating, duplicateError, handleDuplicate }
}
