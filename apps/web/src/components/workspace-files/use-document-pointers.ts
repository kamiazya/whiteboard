import { type Dispatch, type SetStateAction, useCallback, useState } from 'react'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'

/** The object-action menu: which document was right-clicked, and where. */
export interface CardMenuTarget {
  readonly entry: WorkspaceDocumentEntry
  readonly x: number
  readonly y: number
}

/**
 * The four things the panel POINTS AT: the row in the preview pane, the
 * paths a bulk verb would apply to, the right-clicked card's menu, and the
 * document being looked at without being opened.
 *
 * One hook because every one of them NAMES A PATH, and a path belongs to
 * exactly one workspace — so the two events that can make a pointer wrong
 * are the same two for all four, and each was written out per pointer
 * before this.
 */
export interface DocumentPointers {
  readonly selected: WorkspaceDocumentEntry | null
  readonly setSelected: Dispatch<SetStateAction<WorkspaceDocumentEntry | null>>
  readonly selection: ReadonlySet<string> | null
  readonly setSelection: Dispatch<SetStateAction<ReadonlySet<string> | null>>
  readonly cardMenu: CardMenuTarget | null
  readonly setCardMenu: Dispatch<SetStateAction<CardMenuTarget | null>>
  /** Only ever set where tapOpens (no preview pane); see PeekDialog. */
  readonly peek: WorkspaceDocumentEntry | null
  readonly setPeek: Dispatch<SetStateAction<WorkspaceDocumentEntry | null>>
  /**
   * The workspace changed: drop all four.
   *
   * The card menu's verbs close over the CURRENT source while holding a
   * captured entry, so a pointer left behind addresses the departed
   * workspace's path into the one now on screen — and paths collide freely
   * across workspaces, `untitled` most of all. Measured before this: a
   * rename dialog left open across a switch called `setDocumentName` on the
   * new workspace's store.
   */
  readonly clear: () => void
  /**
   * The list was re-read: re-resolve each pointer against it, so the panes
   * show the row as the store now describes it rather than the copy they
   * captured. A pointer whose document is GONE drops, which is what closes
   * a menu offering verbs for a target that no longer exists.
   *
   * `selection` is deliberately not reconciled here: it is a set of paths
   * rather than captured rows, so there is nothing stale to refresh, and
   * what a vanished path should do to a pending bulk verb is a question
   * about that verb rather than about this pointer.
   */
  readonly reconcile: (entries: readonly WorkspaceDocumentEntry[]) => void
}

export function useDocumentPointers(): DocumentPointers {
  const [selected, setSelected] = useState<WorkspaceDocumentEntry | null>(null)
  const [selection, setSelection] = useState<ReadonlySet<string> | null>(null)
  const [cardMenu, setCardMenu] = useState<CardMenuTarget | null>(null)
  const [peek, setPeek] = useState<WorkspaceDocumentEntry | null>(null)

  const clear = useCallback(() => {
    setSelected(null)
    setSelection(null)
    setCardMenu(null)
    setPeek(null)
  }, [])

  const reconcile = useCallback((entries: readonly WorkspaceDocumentEntry[]) => {
    const at = (path: string) => entries.find((row) => row.path === path) ?? null
    setSelected((current) => (current === null ? null : at(current.path)))
    setPeek((current) => (current === null ? null : at(current.path)))
    setCardMenu((current) => {
      if (current === null) return null
      const entry = at(current.entry.path)
      return entry === null ? null : { ...current, entry }
    })
  }, [])

  return {
    selected,
    setSelected,
    selection,
    setSelection,
    cardMenu,
    setCardMenu,
    peek,
    setPeek,
    clear,
    reconcile,
  }
}
