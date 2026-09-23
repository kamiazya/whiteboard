import { type RefObject, useEffect, useRef } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import { documentPath as documentRoutePath, parseWorkspaceRoute } from '../lib/app-routes.js'
import { browserWorkspaceHandleOrNull } from '../lib/browser-workspace-id.js'

/**
 * What a run of the effect below should DO, as a value — so the decision can
 * be read (and tested) without a router, a ref, or an effect.
 *
 * `none` is the common case: the address bar already names the loaded
 * document, or names something this component is itself in the middle of
 * pushing. `switch` is an external navigation to a document we can name.
 * `repair-unless-new` is the address bar naming a path that resolves to
 * nothing — which is a deleted or hand-typed path once the list has been
 * enumerated, and "not known yet" before that.
 */
export function routeSyncAction({
  pathname,
  documentId,
  documentPath,
  lastKnownDocumentId,
  documentIdOfPath,
}: {
  pathname: string
  documentId: string | null
  documentPath: string | null
  lastKnownDocumentId: string | null
  documentIdOfPath: (path: string) => string | null
}): { kind: 'none' } | { kind: 'switch'; documentId: string } | { kind: 'repair-unless-new' } {
  if (documentId === null || documentPath === null) return { kind: 'none' }

  const routed = parseWorkspaceRoute(pathname)
  if (routed?.kind !== 'document') return { kind: 'none' }
  // Compared against the loaded snapshot's OWN path rather than against the
  // list, so this is right before the list has arrived — which is also what
  // makes the unknown-path answer safe to treat as genuinely unknown.
  if (routed.path === documentPath) return { kind: 'none' }

  const requestedId = documentIdOfPath(routed.path)
  if (requestedId === null) return { kind: 'repair-unless-new' }
  if (requestedId === documentId) return { kind: 'none' }
  // The URL still naming the previously-known document is this component's
  // own pending push catching up, not an external navigation.
  if (requestedId === lastKnownDocumentId) return { kind: 'none' }
  return { kind: 'switch', documentId: requestedId }
}

/**
 * Carry out what `routeSyncAction` decided. Both misses are the same
 * recoverable one — keep the document and repair the URL — so both go
 * through one `repair`: the path resolves to nothing (deleted, or
 * hand-typed), or it resolves and the switch then finds no record.
 */
function applyRouteSyncAction(
  action: Exclude<ReturnType<typeof routeSyncAction>, { kind: 'none' }>,
  documentPath: string,
  navigate: NavigateFunction,
  switchDocument: (id: string) => Promise<boolean>,
  documentsEnumeratedRef: RefObject<boolean>,
): void {
  const repairHandle = browserWorkspaceHandleOrNull()
  const repair = () => {
    if (repairHandle === null) return
    navigate(documentRoutePath(repairHandle, documentPath), { replace: true })
  }

  if (action.kind === 'repair-unless-new') {
    // ...but only once the list has actually been enumerated. Until then it
    // holds this document alone, so "absent" means "not known yet" and
    // repairing would overwrite a navigation to a perfectly valid document
    // with nothing to undo it. Leaving the address bar alone keeps the
    // user's intent visible; recovering the switch itself once the list
    // lands needs the effect's own-push guard restructured first, since it
    // assumes one run per loaded document.
    if (documentsEnumeratedRef.current) repair()
    return
  }

  void switchDocument(action.documentId).then((switched) => {
    if (!switched) repair()
  })
}

/**
 * Keeps the loaded document in step with the ADDRESS BAR, which is the one
 * direction no switcher click covers: browser Back/Forward (and any other
 * history navigation) moves `location.pathname` without a switcher click
 * firing. Its sibling effect in the page covers the other direction.
 *
 * It runs in an EFFECT, never during render, so it cannot race the editor's
 * own render cycle; `switchDocument`'s generation guard (see the controller
 * hook) is what protects against a rapid back-back-back burst landing a
 * stale canvas.
 *
 * `lastKnownCanvasIdRef` distinguishes the two ways this effect's own
 * dependencies can change. A switcher-driven `switchDocument()` updates
 * `documentId` BEFORE the sibling effect's `navigate()` has updated
 * `location`, so without it this effect sees a stale pathname still naming
 * the previous document and switches straight back to it. When the URL names
 * the previously-known document, that is this component's own pending push
 * catching up rather than an external navigation — skip it and let the other
 * effect finish the sync.
 *
 * Its own module because that distinction is what the hook is ABOUT, and it
 * needed a ref's worth of reasoning inside a hook already doing eleven other
 * things.
 */
export function useBrowserRouteSync({
  documentId,
  documentPath,
  pathname,
  navigate,
  documentIdOfPath,
  switchDocument,
  documentsEnumeratedRef,
}: {
  documentId: string | null
  documentPath: string | null
  pathname: string
  navigate: NavigateFunction
  documentIdOfPath: (path: string) => string | null
  switchDocument: (id: string) => Promise<boolean>
  documentsEnumeratedRef: RefObject<boolean>
}): void {
  const lastKnownCanvasIdRef = useRef<string | null>(null)
  useEffect(() => {
    // Only a run with a LOADED document records one, and it records before
    // deciding anything — a run that finds nothing to do still establishes
    // which document was loaded.
    if (documentId === null || documentPath === null) return
    const lastKnownDocumentId = lastKnownCanvasIdRef.current
    lastKnownCanvasIdRef.current = documentId

    const action = routeSyncAction({
      pathname,
      documentId,
      documentPath,
      lastKnownDocumentId,
      documentIdOfPath,
    })
    if (action.kind === 'none') return

    applyRouteSyncAction(action, documentPath, navigate, switchDocument, documentsEnumeratedRef)
  }, [pathname, documentId, documentPath, switchDocument])
}
