// The editor's open-dialog and pending-edit state, extracted from
// SpatialEditor: which id-pinned editor is open (edge label, group label,
// link dialog, document picker, facet inspector), the pending-cut hold, the
// selected edge, and the per-user "show resolved comments" toggle. None of
// this reaches the scene — every value here is either read straight off the
// canvas/selection or resolves its target in the render, which is why it is
// called ahead of useWorkerScene.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { useCallback, useEffect, useState } from 'react'
import type { DocumentPickerState, LinkDialogState } from './CanvasContextMenu.js'

export interface EditSessionStateInputs {
  readonly canvas: SpatialCanvas
  readonly selectedId: string | null
}

export function useEditSessionState({ canvas, selectedId }: EditSessionStateInputs) {
  /**
   * Whether resolved comments are drawn (muted) — ADR-0025 decision 2:
   * per-user VIEW state, never written to the shared document, so one
   * person's toggle cannot change what another person sees.
   */
  const [showResolvedComments, setShowResolvedComments] = useState(false)
  /**
   * The ink the selection holds — edges and lines alike, since the scene
   * hands both out the same way and only `deleteInkCommand` has cause to
   * ask which collection.
   *
   * A LIST rather than one id, because the marquee is how a scribble gets
   * erased: several strokes at once is the ordinary case, and a single-slot
   * selection made the band's answer "whichever one, arbitrarily". A press
   * still selects exactly one, which is why the single-target derivations
   * below stay honest.
   */
  const [selectedInkIds, setSelectedInkIds] = useState<readonly string[]>([])
  /**
   * The ink a SINGLE-target surface acts on: the context menu, the lock
   * toggle, the label editor, the facet panel. Each is about one object by
   * its nature, and with a multi-selection the first is the one the press
   * that started it chose.
   */
  const selectedEdgeId = selectedInkIds[0] ?? null
  const setSelectedEdgeId = useCallback(
    (id: string | null) => setSelectedInkIds(id === null ? [] : [id]),
    [],
  )
  /**
   * Drops the ink a predicate no longer vouches for — gone from the canvas,
   * or locked out from under the selection. One shape for both, because the
   * selection's rule is the same either way: an id nothing lays out is
   * invisible rather than inert, and a stale one reaches Delete.
   */
  const retainInk = useCallback(
    (keep: (id: string) => boolean) =>
      setSelectedInkIds((current) => {
        const next = current.filter(keep)
        return next.length === current.length ? current : next
      }),
    [],
  )
  /**
   * A cut waiting for its paste — the front half of a move. Pure view
   * state (never persisted or synced): the nodes stay in the document,
   * dimmed by GhostOverlay, until a same-canvas paste MOVES them, or the
   * hold is lifted (Escape, a newer copy/cut, or any edit that touches a
   * held node). `snapshot` records each held node's full serialized value
   * at cut time so ANY change — a drag, a text or color edit, a remote
   * write, a delete — reads as "someone touched it" and cancels the hold;
   * nothing is ever lost by a cancel, because nothing was deleted.
   */
  const [pendingCut, setPendingCut] = useState<{
    readonly cutId: string
    readonly snapshot: ReadonlyMap<string, string>
  } | null>(null)
  useEffect(() => {
    // Anyone touching a held element — local drag, remote edit, delete —
    // lifts the hold; the veil must never dim something that changed under
    // it. The move resolution clears the hold before it applies, so its
    // own geometry change never races this.
    //
    // BOTH collections, because a cut holds strokes too. Looking in
    // `canvas.nodes` alone did not merely miss them: a held id that names no
    // node reads as DELETED, so the hold lifted on the very next render and
    // a cut stroke pasted as a copy instead of moving. That is the shape
    // this session has been closing all day — a reader that names one
    // collection, over a canvas that holds four.
    if (pendingCut === null) return
    const touched = [...pendingCut.snapshot].some(([id, frozen]) => {
      const held =
        canvas.nodes.find((node) => node.id === id) ??
        (canvas.lines ?? []).find((line) => line.id === id)
      return held === undefined || JSON.stringify(held) !== frozen
    })
    if (touched) setPendingCut(null)
  }, [canvas, pendingCut])
  const [edgeLabelEditId, setEdgeLabelEditId] = useState<string | null>(null)
  // The URL dialog serves both palette-create and context-menu-edit; which
  // one decides what its submit does.
  const [groupLabelEditId, setGroupLabelEditId] = useState<string | null>(null)
  const [linkDialog, setLinkDialog] = useState<LinkDialogState | null>(null)
  const [canvasPicker, setDocumentPicker] = useState<DocumentPickerState | null>(null)
  // The inspector is open or shut; WHICH object it edits follows the
  // selection — a node or an edge, since both carry facets. Pinning it to
  // the object the menu was opened on made it a dialog you had to close
  // before you could look at anything else.
  const [facetPanelOpen, setFacetPanelOpen] = useState(false)
  // Deselecting CLOSES it, rather than leaving it standing with nothing to
  // edit. It is the same act that dismisses the context menu, and on touch
  // a press on blank canvas is how you put a surface away — one semantic
  // instead of two, and no dismiss control for this panel to carry.
  //
  // Cleared during render rather than in an effect, the shape
  // `DerivedFacetForm` uses for its draft: an effect would let the panel
  // paint one frame with nothing in it. Clearing the FLAG (rather than
  // rendering null and leaving it true) is what keeps a later re-open an
  // ordinary open — the earlier version of this returned null and stranded
  // the flag, which only a new selection could get out of.
  if (facetPanelOpen && selectedId === null && selectedEdgeId === null) setFacetPanelOpen(false)

  return {
    showResolvedComments,
    setShowResolvedComments,
    selectedEdgeId,
    setSelectedEdgeId,
    selectedInkIds,
    setSelectedInkIds,
    retainInk,
    pendingCut,
    setPendingCut,
    edgeLabelEditId,
    setEdgeLabelEditId,
    groupLabelEditId,
    setGroupLabelEditId,
    linkDialog,
    setLinkDialog,
    canvasPicker,
    setDocumentPicker,
    facetPanelOpen,
    setFacetPanelOpen,
  }
}
