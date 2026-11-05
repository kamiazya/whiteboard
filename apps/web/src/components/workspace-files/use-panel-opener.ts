import { useCallback, useRef } from 'react'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { type ListSurface, noteListDeparture } from '../../lib/list-departure.js'
import { openOnSingleActivation } from '../../lib/open-on-single-activation.js'
import type { WorkspaceFilesPanelProps } from './workspace-files-panel-props.js'

/**
 * Every open from the panel, so each one lands in this device's Recent lane
 * and seen baseline. Nothing is remembered where the host offers no open:
 * selecting a document is looking at it, not opening it. `openPath` takes a
 * null entry when the listing does not hold the path yet, which still opens.
 * `offered` is `openEntry` only where the host offers an open, for the
 * surfaces that hide the verb otherwise.
 */
export function usePanelOpener(
  onOpenDocument: WorkspaceFilesPanelProps['onOpenDocument'],
  remember: (entry: WorkspaceDocumentEntry) => void,
  select: (entry: WorkspaceDocumentEntry) => void,
) {
  /**
   * On a coarse pointer a tap on a document OPENS it, matching the gallery
   * convention every canvas product shares (Figma, Miro, Freeform: tap =
   * open, long-press = the object menu) — select-then-Open was two taps and
   * left the Open button below the fold on a phone. On a fine pointer a click
   * selects into the preview; double-click and Enter open.
   *
   * Gated on the host actually offering an open: a read-only host keeps the
   * selection behavior AND the preview column, because looking is all there
   * is to do.
   */
  const tapOpens = openOnSingleActivation() && onOpenDocument !== undefined
  // Through a ref so neither opener changes identity with the host's handler:
  // a host that passes an inline arrow would otherwise re-create both, and
  // the create callback that calls one, on every render of the page above.
  const openRef = useRef(onOpenDocument)
  openRef.current = onOpenDocument
  /**
   * `from` is the row Back returns to when it is not the opened document's
   * own: a link followed in the preview leaves from the card holding it.
   */
  const openPath = useCallback(
    (
      path: string,
      entry: WorkspaceDocumentEntry | null,
      from?: { readonly path?: string | undefined; readonly surface?: ListSurface },
    ) => {
      const open = openRef.current
      if (open === undefined) return
      if (entry !== null) remember(entry)
      noteListDeparture(from?.path ?? path, from?.surface)
      open(path)
    },
    [remember],
  )
  const openEntry = useCallback(
    (entry: WorkspaceDocumentEntry) => openPath(entry.path, entry),
    [openPath],
  )
  const openFromRecent = useCallback(
    (entry: WorkspaceDocumentEntry) => openPath(entry.path, entry, { surface: 'recent' }),
    [openPath],
  )
  const selectOrOpen = tapOpens ? openEntry : select
  return {
    tapOpens,
    openEntry,
    openFromRecent,
    openPath,
    selectOrOpen,
    offered: onOpenDocument === undefined ? undefined : openEntry,
  }
}
