import type { DocumentKind } from '@kamiazya/whiteboard-model'
import {
  CheckCircle2,
  Columns2,
  CopyPlus,
  ExternalLink,
  Eye,
  List,
  Pencil,
  Pin,
  PinOff,
  Search,
  Trash2,
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip.js'
import { useThemeMode } from '../../hooks/useThemeMode.js'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { type WorkspaceFilesSource, WorkspaceMissingError } from '../../lib/files-source.js'
import { newDocumentPathIn } from '../../lib/new-document-path.js'
import { hasCoarsePointer } from '../../lib/platform.js'
import { createInTabRenderBroker } from '../../lib/render-broker.js'
import { ContextMenu } from '../spatial-editor/ContextMenu.js'
import { DocumentMinimap } from './DocumentMinimap.js'
import { DocumentPreview } from './DocumentPreview.js'
import { DocumentThumbnail } from './DocumentThumbnail.js'
import { FolderBreadcrumb } from './FolderBreadcrumb.js'
import { FolderContentsList } from './FolderContentsList.js'
import { createRowOutlineLoader } from './load-row-outline.js'
import { createRowRenderLoader } from './load-row-render.js'
import { NewDocumentMenu } from './NewDocumentMenu.js'
import { PeekDialog } from './PeekDialog.js'
import { RecentLane } from './RecentLane.js'
import { RenameDocumentDialog } from './RenameDocumentDialog.js'
import { SearchResults } from './SearchResults.js'
import { SelectionBar } from './SelectionBar.js'
import { searchDocuments, withNameMatches } from './search-documents.js'
import { TagStrip } from './TagStrip.js'
import { TrashSection } from './TrashSection.js'
import { useBrowserColumns } from './use-browser-columns.js'
import { useDebouncedDocumentSearch } from './use-debounced-document-search.js'
import { useDeviceMemory } from './use-device-memory.js'
import { useDocumentPointers } from './use-document-pointers.js'
import { type RenameDocument, useRenameDocument } from './use-rename-document.js'
import { useTagsInUse } from './use-tags-in-use.js'
import { useWriteOutcome } from './use-write-outcome.js'
import { WorkspaceFileTree } from './WorkspaceFileTree.js'
import { WorkspaceFolderTree } from './WorkspaceFolderTree.js'

export interface WorkspaceFilesPanelProps {
  /**
   * Where the documents live. The panel itself no longer knows which mode it
   * is in — the daemon and the browser store each supply one of these,
   * which is what lets one browser serve both.
   */
  source: WorkspaceFilesSource
  /**
   * The handle this workspace's URLs carry, when the host knows it.
   *
   * Used only to draw the head of a document's URL in front of the path
   * fields, so a person can see where their text lands. Absent while a page
   * is still resolving its address, and on a host that has no address to
   * give — the fields simply lose the prefix, which is why this is optional
   * rather than something the panel refuses to render without.
   */
  workspace?: string | undefined
  /** Absent means the preview shows no way in — looking still works. */
  onOpenDocument?: (path: string) => void
  /**
   * The folder to open in, and a report of every move away from it.
   *
   * Uncontrolled-with-a-default rather than a controlled `folder` prop: the
   * panel deliberately holds no router (its tests render it bare, and
   * `app-routes.ts` is framework-agnostic on purpose), so the host reads the
   * URL and the panel owns the state. Which means a host must WRITE the
   * address with `replace`, never push — an uncontrolled panel cannot follow
   * a Back that changes only the query string, and a URL the UI silently
   * disagrees with is worse than no folder in the URL at all.
   */
  initialFolder?: string
  onFolderChange?: (folder: string) => void
  /**
   * Copy and ask-to-delete. Both stay with the page: it already owns the
   * duplicate that the grid used and the confirmation dialog that guards a
   * delete, and a second copy of either would be a second set of rules for
   * the same destructive act.
   */
  onDuplicateDocument?: (path: string) => void
  onRequestDelete?: (path: string, displayName: string, kind?: DocumentKind) => void
  /**
   * Delete every one of these paths, behind ONE confirmation.
   *
   * Page-owned for the same reason the single delete is: the confirmation
   * dialog and the store call already live there, and a second copy of
   * either would be a second set of rules for the same destructive act. Its
   * absence is what withholds selection mode — a mode whose only verb
   * cannot fire is a mode with nothing in it.
   */
  onRequestDeleteMany?: (paths: readonly string[]) => void
  /**
   * Any value that changes when the workspace's documents may have changed
   * behind this panel's back.
   *
   * The page performs duplicate and delete on the browser's behalf, and a
   * delete finishes later still, in a confirmation dialog the panel does not
   * own — so neither can be awaited here. Without this the deleted document
   * stayed on screen with a live Delete bound to a path that no longer
   * existed, and a duplicate never appeared at all.
   */
  revision?: unknown
}

/**
 * How a write that landed is named once its list refresh failed. The verb is
 * the message: it says what is now TRUE despite the stale list, which is what
 * stops the person pressing again.
 */
const REFRESH_FAILURE_VERB: Record<'created' | 'pinned' | 'unpinned', string> = {
  created: 'Created',
  pinned: 'Pinned',
  unpinned: 'Unpinned',
}

/**
 * The workspace document browser (`/api/v1`), in three panes: the folder
 * sidebar, the contents of the selected folder, and the selected document
 * drawn.
 *
 * Each pane is driven by exactly one to its left, so the three cannot
 * disagree about what is selected. Both the cards and the preview draw from
 * the same renderer at two sizes, so a thumbnail is always a small version
 * of what the preview shows.
 */
export function WorkspaceFilesPanel({
  source,
  workspace,
  onOpenDocument,
  initialFolder,
  onFolderChange,
  onDuplicateDocument,
  onRequestDelete,
  onRequestDeleteMany,
  revision,
}: WorkspaceFilesPanelProps) {
  const { resolvedTheme } = useThemeMode()
  const [documents, setDocuments] = useState<readonly WorkspaceDocumentEntry[] | null>(null)
  // 'not-found' is a workspace with no v1 tree yet — a calm empty state, not
  // a failure. 'error' is a genuine fetch/schema failure and keeps the alert.
  const [listStatus, setListStatus] = useState<'ok' | 'not-found' | 'error'>('ok')
  // The four things the panel points AT, and the two rules that keep a
  // pointer from naming a document that is not there — see
  // use-document-pointers.ts.
  const {
    selected,
    setSelected,
    selection,
    setSelection,
    cardMenu,
    setCardMenu,
    peek,
    setPeek,
    clear: clearPointers,
    reconcile: reconcilePointers,
  } = useDocumentPointers()
  /**
   * How many cards the last successful listing drew, kept so a RE-READ can
   * hold the layout it is about to replace.
   *
   * A workspace switch nulls `documents`, and the panel used to answer that
   * with one line of text — measured on a real switch, the panel's box went
   * 552px -> 0 -> 552 for 47ms, which is the jolt everything below it
   * inherits. The skeleton below reserves the same room instead, and
   * `.skeleton-appear`'s 300ms delay means a fast re-read never shows it at
   * all: quiet background, unchanged geometry.
   */
  const lastCardCount = useRef(0)
  // '' is the workspace root, which is where a freshly loaded tree starts —
  // unless the address named a folder, which is the whole point of naming it.
  const [folder, setFolder] = useState(initialFolder ?? '')
  const { columns, chooseColumns } = useBrowserColumns()
  const {
    recentIds,
    changed,
    remember: rememberOpen,
    reset: resetDeviceMemory,
  } = useDeviceMemory(workspace, documents)
  // What the panel has to SAY about its last write — a refused create, a
  // refused pin, or a write that landed while its list re-read did not.
  // Each one's reasoning lives with it in use-write-outcome.ts; `beginWrite`
  // is the rule the three share, and the reason they are one hook.
  const outcome = useWriteOutcome()
  // The `disabled` attribute is the whole double-press mechanism: React
  // flushes this state before a second click can dispatch, while a
  // handler-side early return would read a stale closure in exactly the
  // same-tick case it exists to catch.
  const [creating, setCreating] = useState(false)
  const {
    query,
    setQuery,
    hits,
    searchDegraded,
    resetResults: resetSearchResults,
  } = useDebouncedDocumentSearch(source, revision)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const {
    tags: workspaceTags,
    reload: loadTagsInUse,
    reset: resetTagsInUse,
  } = useTagsInUse(source, documents)
  const activeTag = query.trim().startsWith('#') ? query.trim().slice(1) : null

  // One broker for the whole panel. Deliberately NOT keyed on the theme the
  // loader below is: a markdown render is theme-independent (its ink comes
  // from CSS), so its entries survive a theme toggle, and a spatial render
  // carries the theme in its own key. Rebuilding the broker per theme would
  // throw both away — which is the measured "dark mode re-renders every row".
  const broker = useMemo(() => createInTabRenderBroker(), [source])

  // One loader for the whole panel, so a re-render does not hand every card
  // a new function and re-trigger its render.
  const loadRender = useMemo(
    () => createRowRenderLoader({ source, theme: resolvedTheme, broker }),
    [source, resolvedTheme, broker],
  )

  // The row-size rendition. Separate from `loadRender` on purpose: it asks
  // the worker for block geometry rather than a serialized SVG, which is
  // both cheaper and the only thing legible at 24px (see DocumentMinimap).
  const loadOutline = useMemo(() => createRowOutlineLoader({ source, broker }), [source, broker])

  const readList = useCallback(() => source.listDocuments(), [source])

  /** What the last list read was taken at, so the two effects below do not repeat one another. */
  const readAtRef = useRef<{ readList: unknown; revision: unknown } | null>(null)
  const revisionRef = useRef(revision)
  revisionRef.current = revision

  /**
   * Re-reads the list and re-selects the row at `path`.
   *
   * Five call sites did these three lines: after a create, after a rename
   * that only renamed, after a rename that was REFUSED (the first of its two
   * writes may already have landed, so the screen has to be made true again),
   * after a pin toggle, and after a move. A document the read no longer holds
   * clears the selection rather than leaving a row nothing backs — which is
   * what `?? null` means and why it is the same in all five.
   *
   * It throws what `readList` throws; each caller already decides what a
   * failed re-read means there, and those answers genuinely differ.
   */
  const refreshAndSelect = useCallback(
    async (path: string) => {
      const entries = await readList()
      setDocuments(entries)
      setSelected(entries.find((row) => row.path === path) ?? null)
    },
    [readList],
  )

  // Through a ref so it never joins an effect's dependencies: a host that
  // passes an inline arrow would otherwise re-run the workspace-load effect
  // on every render of the page above.
  const onFolderChangeRef = useRef(onFolderChange)
  onFolderChangeRef.current = onFolderChange
  // Same reason as the folder callback: kept out of createHere's dependency
  // list so an inline arrow from the page above cannot re-create it.
  const onOpenDocumentRef = useRef(onOpenDocument)
  onOpenDocumentRef.current = onOpenDocument
  // Read through a ref for the same reason `onOpenDocument` is: `openEntry`
  // is handed to four children and its identity has to stay stable.
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace
  const lastReadListRef = useRef(readList)

  /**
   * Tap-to-open (2026-09-05 redesign). On a coarse pointer a tap on a
   * document card OPENS it, matching the gallery convention every canvas
   * product shares (Figma, Miro, Freeform: tap = open, long-press = the
   * object menu) — the select-then-Open round trip was two taps everywhere
   * and left the Open button below the fold on a phone. On a fine pointer a
   * click still selects into the preview; double-click and Enter open.
   *
   * Gated on the host actually offering an open: a read-only host keeps the
   * selection behavior AND the preview column, because looking is all there
   * is to do.
   */
  const tapOpens = hasCoarsePointer() && onOpenDocument !== undefined
  const openEntry = useCallback((entry: WorkspaceDocumentEntry) => {
    rememberOpen(entry)
    onOpenDocumentRef.current?.(entry.path)
  }, [])

  const toggleSelected = useCallback((entry: WorkspaceDocumentEntry) => {
    setSelection((current) => {
      const next = new Set(current ?? [])
      if (next.has(entry.path)) next.delete(entry.path)
      else next.add(entry.path)
      // Emptying it ENDS the mode rather than leaving an empty toggle grid
      // with a bar offering to delete nothing.
      return next.size === 0 ? null : next
    })
  }, [])

  // A selected path that has left the listing leaves the selection with it.
  // Pruned rather than merely filtered at the point of use: filtering would
  // keep the stale path in state, so a document restored from the trash
  // mid-selection would come back already selected — a document the person
  // never chose in this session, in a bulk delete.
  useEffect(() => {
    if (documents === null) return
    setSelection((current) => {
      if (current === null) return current
      const live = [...current].filter((path) => documents.some((each) => each.path === path))
      // Same identity when nothing was pruned, or this sets state on every
      // listing and re-renders forever.
      if (live.length === current.size) return current
      return live.length === 0 ? null : new Set(live)
    })
  }, [documents])

  const deleteSelected = () => {
    if (selection === null || documents === null) return
    // In the order SHOWN, not in insertion order: the confirmation names a
    // count and the page deletes a list, and a reader comparing the two
    // should not have to reconcile two orders.
    const paths = documents.filter((each) => selection.has(each.path)).map((each) => each.path)
    if (paths.length === 0) return
    // The selection is NOT cleared here. The page confirms first, and a
    // cancelled confirmation must return the person to what they had chosen.
    // What clears it is the re-read after a delete that landed: the pruning
    // effect above drops every path that left the listing, so a PARTIAL
    // failure leaves exactly the documents that survived still selected,
    // with no outcome plumbed back through a prop.
    const only = paths.length === 1 ? documents.find((each) => each.path === paths[0]) : undefined
    // A single selection borrows the singular confirmation, which NAMES the
    // document. A plural dialog reading "Delete 1 document?" would be a
    // second confirmation that has to agree in number for no gain.
    if (only !== undefined && onRequestDelete !== undefined) {
      onRequestDelete(only.path, only.name ?? only.path, only.kind)
      return
    }
    onRequestDeleteMany?.(paths)
  }

  // SCOPE RESET — see scoped-screen-state.test.ts
  useEffect(() => {
    let cancelled = false
    setDocuments(null)
    setListStatus('ok')
    clearPointers()
    // The departed workspace's memory names its documents.
    resetDeviceMemory()
    // A rename dialog left open across a switch called `setDocumentName` on
    // the NEW workspace's store — it holds a captured entry the same way a
    // pointer does, and paths collide freely across workspaces.
    renameRef.current.cancel()
    // Results computed against the departed workspace's content, still
    // clickable. The search effect does re-run on a source change, but only
    // after its debounce — until then these rows name documents that are not
    // here.
    resetSearchResults()
    // Every one of them names a path, and their message is about a write
    // that happened somewhere else.
    outcome.beginWrite()
    // The vocabulary is the departed keeper's until the new one answers.
    resetTagsInUse()
    // Guarded by the source's IDENTITY, not by a first-run flag: an
    // `initialFolder` is a deliberate address and must survive mounting,
    // while StrictMode replays this effect with the SAME readList — which a
    // run-count flag would read as a second workspace and reset (the trap
    // App.tsx's route sync documents). Only an actual change is a switch.
    if (lastReadListRef.current !== readList) {
      lastReadListRef.current = readList
      setFolder('')
      // The host's address still names the old workspace's folder; left
      // unsaid, it would keep pointing at a folder nobody is looking at.
      onFolderChangeRef.current?.('')
    }
    readAtRef.current = { readList, revision: revisionRef.current }
    readList()
      .then((entries) => {
        if (cancelled) return
        lastCardCount.current = entries.length
        setDocuments(entries)
      })
      .then(() => loadTagsInUse())
      .catch((err) => {
        if (cancelled) return
        setListStatus(err instanceof WorkspaceMissingError ? 'not-found' : 'error')
      })
    return () => {
      cancelled = true
    }
  }, [readList])

  // Deliberately NOT the effect above: that one is the workspace changing,
  // and it resets the open folder. A document appearing or disappearing must
  // leave someone exactly where they were standing. The selection is dropped
  // only when the document it pointed at is gone.
  //
  // Both effects read the same list, and on a mount — or a workspace switch —
  // both run for the same `readList` with the same `revision`, so the panel
  // asked the daemon for every document twice before anyone had touched
  // anything. Measured on the addressed cold load, which is what a bookmark
  // and every reload take. The run that would REPEAT what the effect above
  // just read is skipped; every later revision still refreshes, which is the
  // whole reason this effect exists.
  useEffect(() => {
    if (revision === undefined) return
    if (readAtRef.current?.readList === readList && readAtRef.current.revision === revision) return
    readAtRef.current = { readList, revision }
    let cancelled = false
    void loadTagsInUse()
    readList()
      .then((entries) => {
        if (cancelled) return
        setDocuments(entries)
        // A refresh behind the panel's back is the whole reason `revision`
        // exists, and every pointer is a captured snapshot taken before it.
        reconcilePointers(entries)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [revision, readList])

  /**
   * Move a document and re-read the list.
   *
   * A move is the one action here that changes what every pane is showing —
   * a subtree lands somewhere else entirely — so the list is re-read rather
   * than patched. The selection follows the document to its new path,
   * because losing it would leave the preview blank right when someone wants
   * to see that the move landed.
   *
   * The rejection is re-thrown: the pane that asked owns the message, and
   * this is the only place that knows it was the server's words.
   */
  /**
   * The address a create with no opinion lands at: inside the folder the
   * browser is standing in, numbered past whatever is already there.
   *
   * Derived once and shared, because the menu's dialog has to PRE-FILL with
   * the very path its plain entries would have used — submitting that form
   * untouched must produce what not opening it would have. Two separate
   * derivations would drift the moment one of them was given a different
   * list.
   */
  const derivedNewPath = useMemo(
    () =>
      newDocumentPathIn(
        folder,
        (documents ?? []).map((row) => row.path),
      ),
    [folder, documents],
  )

  /**
   * Create a document in the folder the browser is standing in.
   *
   * Until now the only way to put a document anywhere but the workspace root
   * was MCP or raw HTTP, which left the browser showing a hierarchy it had
   * no way to add to. Naming still follows creation (ADR-0006) — the menu's
   * two kind entries collect nothing — and the dialog behind its third entry
   * is an opt-in for someone who already knows, never a gate. A path is
   * still never derived from a name (ADR-0008); the dialog takes both, and
   * neither field feeds the other.
   */
  const createHere = useCallback(
    async (kind: DocumentKind, options?: { path: string; name: string | undefined }) => {
      // Every action here clears ALL of the panel's transient reports, not
      // just its own: an alert that outlives the action it describes is
      // attached to nothing the person can still see.
      outcome.beginWrite()
      setCreating(true)
      try {
        // No options means nobody expressed an opinion, so the address is
        // derived exactly as it always was. The dialog is the only caller
        // that supplies one.
        const path = options?.path ?? derivedNewPath
        // ONLY this write decides whether the create was refused. Everything
        // below is bookkeeping on a document that already exists, and
        // reporting a failed refresh as "could not create" invites a retry
        // that collides with what was just made — from the dialog, while the
        // form is still open holding the path that now exists.
        try {
          await source.createDocument(path, kind, options?.name)
        } catch (err) {
          outcome.reportCreateRefusal({
            kind,
            reason:
              err instanceof Error ? err.message : `Could not create a ${kind} document here.`,
          })
          // Re-thrown so the caller can tell a refusal from a success — the
          // dialog stays open on one and closes on the other, and swallowing
          // it here would close it either way.
          throw err
        }
        try {
          await refreshAndSelect(path)
          // Creating exists to produce content, and an empty document is
          // worth nothing until it is open — so the create ends where the
          // next thing happens, as every other creation path in the app
          // already did.
          //
          // Only affordable because the open folder is in the address now:
          // the way back returns to the folder this was made in, rather than
          // to the workspace root. The selection above still lands, so a
          // host that offers no way to open leaves someone looking at the
          // new document rather than at nothing.
          onOpenDocumentRef.current?.(path)
        } catch {
          // Swallowed as a REJECTION, reported as its own message. The
          // document exists; letting this propagate would hold the dialog
          // open on a form whose only offer is to make it again.
          outcome.reportStaleList({ action: 'created', path })
        }
      } finally {
        setCreating(false)
      }
    },
    [source, readList, derivedNewPath],
  )

  /**
   * Leaving a search puts the folder view back, and the selection has to be
   * put back with it: a result can come from anywhere, and the preview must
   * never show a document the list beside it does not contain.
   *
   * Kept when it IS in the open folder — unlike a move, that case is real
   * here (search from inside `design`, pick `design/login`, clear), and
   * dropping it would lose a selection for no reason anyone could see.
   */
  const changeQuery = useCallback(
    (next: string) => {
      if (query.trim() !== '' && next.trim() === '') {
        setSelected((current) => {
          if (current === null) return null
          const cut = current.path.lastIndexOf('/')
          const parent = cut === -1 ? '' : current.path.slice(0, cut)
          return parent === folder ? current : null
        })
      }
      setQuery(next)
    },
    [query, folder],
  )

  /**
   * Apply whatever the rename dialog changed: the name through the source's
   * workspace-side setter, the path through the same move the panel already
   * performs. Both, in that order, when both changed — a failed move then
   * leaves the new name applied, which is honest: the dialog stays open on
   * the server's refusal and the field still shows what was typed.
   */

  /**
   * Pinning used to be settable only from the editor header's document
   * switcher. That switcher is gone, and the ordering it fed
   * (`compareDocumentEntries`) is still here — so the affordance moves onto
   * the object it acts on rather than being lost with the menu it happened
   * to live in.
   */
  const togglePinned = useCallback(
    async (entry: WorkspaceDocumentEntry) => {
      if (source.setPinned === undefined) return
      const pinning = entry.pinOrder === undefined
      outcome.beginWrite()
      // ONLY this write decides whether the pin was refused. What follows is
      // bookkeeping on an order that has already changed, and reporting a
      // failed refresh as "could not pin" invites a second press that would
      // undo the pin that landed.
      try {
        await source.setPinned(entry, pinning)
      } catch (err) {
        outcome.reportPinRefusal({
          pinning,
          path: entry.path,
          reason: err instanceof Error ? err.message : 'The store gave no reason.',
        })
        // Not re-thrown, unlike a refused create: nothing is waiting on this
        // one. The menu entry that calls it has already closed, and the
        // report above is the whole outcome.
        return
      }
      try {
        await refreshAndSelect(entry.path)
      } catch {
        outcome.reportStaleList({ action: pinning ? 'pinned' : 'unpinned', path: entry.path })
      }
    },
    [source, readList],
  )

  const moveDocument = useCallback(
    async (entry: WorkspaceDocumentEntry, newPath: string) => {
      await source.renameDocumentPath(entry.path, newPath)
      await refreshAndSelect(newPath)
      const landedIn = newPath.includes('/') ? newPath.slice(0, newPath.lastIndexOf('/')) : ''
      setFolder(landedIn)
      onFolderChangeRef.current?.(landedIn)
    },
    [source, readList],
  )
  // The rename flow owns its own three states (see use-rename-document.ts)
  // and takes `moveDocument` directly — it is declared above, so the ref that
  // used to bridge the two is gone with it.
  const rename = useRenameDocument({ source, moveDocument, refreshAndSelect })
  // The scope reset runs ABOVE this (it clears everything a document names
  // the moment the workspace changes), so it reaches the flow through a ref
  // rather than by moving one of the two — both are hooks, and their order
  // is load-bearing.
  const renameRef = useRef<RenameDocument>(rename)
  renameRef.current = rename

  /**
   * Moving the contents pane always empties the preview.
   *
   * A document can only be opened from the folder it lives in, so a preview
   * that survives a folder change is always showing something the contents
   * pane no longer lists — and the pane has no row left to mark, so nothing
   * on screen says which document it belongs to.
   */
  const selectFolder = (path: string) => {
    setFolder(path)
    setSelected(null)
    onFolderChangeRef.current?.(path)
  }

  if (listStatus === 'error') {
    return (
      <p role="alert" className="text-destructive text-sm">
        Failed to load the workspace file tree.
      </p>
    )
  }
  if (listStatus === 'not-found') {
    return <p className="text-muted-foreground text-sm">This workspace has no document tree yet.</p>
  }
  // Plain function, deliberately not a hook: this sits below the early
  // returns, where a hook would change the count between renders.
  // ContextMenu's x/y contract is ROOT-local (its absolute box resolves
  // against the nearest positioned ancestor — the panel root below), so the
  // viewport coordinates the click carries are converted here instead of
  // leaning on the app shell never scrolling the window.
  const openCardMenu = (entry: WorkspaceDocumentEntry, clientX: number, clientY: number) => {
    const rect = rootRef.current?.getBoundingClientRect()
    setCardMenu({
      entry,
      x: clientX - (rect?.left ?? 0),
      y: clientY - (rect?.top ?? 0),
    })
  }

  const cardMenuItems =
    cardMenu === null
      ? []
      : [
          ...(onOpenDocument === undefined
            ? []
            : [
                {
                  label: 'Open',
                  icon: <ExternalLink />,
                  onSelect: () => onOpenDocument(cardMenu.entry.path),
                },
              ]),
          ...(tapOpens
            ? [
                {
                  label: 'Preview',
                  icon: <Eye />,
                  onSelect: () => setPeek(cardMenu.entry),
                },
              ]
            : []),
          ...(onDuplicateDocument === undefined
            ? []
            : [
                {
                  label: 'Duplicate',
                  icon: <CopyPlus />,
                  onSelect: () => onDuplicateDocument(cardMenu.entry.path),
                },
              ]),
          ...(source.setPinned === undefined
            ? []
            : [
                {
                  label: cardMenu.entry.pinOrder === undefined ? 'Pin' : 'Unpin',
                  icon: cardMenu.entry.pinOrder === undefined ? <Pin /> : <PinOff />,
                  onSelect: () => void togglePinned(cardMenu.entry),
                },
              ]),
          ...(onRequestDeleteMany === undefined
            ? []
            : [
                {
                  label: 'Select',
                  icon: <CheckCircle2 />,
                  onSelect: () => setSelection(new Set([cardMenu.entry.path])),
                },
              ]),
          {
            label: 'Rename…',
            icon: <Pencil />,
            onSelect: () => {
              setSelected(cardMenu.entry)
              rename.open(cardMenu.entry)
            },
          },
          ...(onRequestDelete === undefined
            ? []
            : [
                {
                  label: 'Delete',
                  icon: <Trash2 />,
                  danger: true,
                  onSelect: () =>
                    onRequestDelete(
                      cardMenu.entry.path,
                      cardMenu.entry.name ?? cardMenu.entry.path,
                      cardMenu.entry.kind,
                    ),
                },
              ]),
        ]

  /**
   * Which of four things the column area is showing, and the documents that
   * view has — named rather than left implicit in a chain of tests about
   * different subjects.
   *
   * It was `documents === null ? … : query.trim() !== '' ? … : columns ===
   * 'one' ? … : …`, and a reader had to derive the last arm from the absence
   * of the other three. The chain also carried a NARROWING that its shape
   * hid: every arm after the first runs only when `documents` is non-null,
   * and nothing said so except the order. Here the union says it, so the
   * three loaded views get the array and the loading view cannot ask for one.
   */
  type ColumnView =
    | { kind: 'loading' }
    | { kind: 'searching'; documents: readonly WorkspaceDocumentEntry[] }
    | { kind: 'browseOne'; documents: readonly WorkspaceDocumentEntry[] }
    | { kind: 'browseTwo'; documents: readonly WorkspaceDocumentEntry[] }

  const columnView: ColumnView =
    documents === null
      ? { kind: 'loading' }
      : query.trim() !== ''
        ? { kind: 'searching', documents }
        : columns === 'one'
          ? { kind: 'browseOne', documents }
          : { kind: 'browseTwo', documents }

  const renderColumns = (): ReactNode => {
    switch (columnView.kind) {
      case 'loading':
        return (
          // A re-read (a workspace switch, most of all) keeps the toolbar
          // above and the room below: measured on a real switch, replacing
          // the whole section with one line of text moved the card area up
          // 38px and back within 54ms, which is the jolt everything inherits.
          // `.skeleton-appear` holds it invisible for 300ms, so a fast
          // re-read shows quiet background rather than a flash of
          // placeholders.
          <div
            role="status"
            aria-label="Loading documents"
            className="skeleton-appear grid min-w-0 flex-1 grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] content-start gap-2 p-0.5 md:grid-cols-[repeat(auto-fill,minmax(13rem,1fr))]"
          >
            {Array.from({ length: Math.max(lastCardCount.current, 1) }, (_, i) => (
              <div key={i} className="overflow-hidden rounded-md border">
                <div className="bg-muted/40 aspect-video w-full animate-pulse" />
                <div className="px-2 py-1.5">
                  <div className="bg-muted h-4 w-2/3 animate-pulse rounded" />
                </div>
              </div>
            ))}
          </div>
        )
      case 'searching':
        return (
          // Results come from everywhere, so neither the folder tree nor the
          // folder's own contents describes them. One flat list, in both
          // column modes — a search that behaved differently per mode would
          // be two features wearing one box.
          <div className="min-w-0 flex-1 overflow-y-auto md:border-r md:pr-3">
            <div data-testid="search-results">
              {/* Always mounted, text swapped: a polite live region added to
                the DOM already carrying its message is announced
                inconsistently (see polite-live-region.test.ts). */}
              <p
                role="status"
                className={searchDegraded ? 'text-muted-foreground mb-1 text-xs' : 'sr-only'}
              >
                {searchDegraded
                  ? 'Searching names and paths only — this workspace’s content search is unavailable.'
                  : ''}
              </p>
              <SearchResults
                {...(onOpenDocument === undefined ? {} : { onActivate: openEntry })}
                // A `#tag` query is a FILTER over what is loaded (#975's
                // contract), not a content search — it never leaves the
                // client. Everything else asks the source.
                results={
                  activeTag !== null || hits === null
                    ? // A `#tag` query is a FILTER over what is loaded
                      // (#975's contract) and never leaves the client; and
                      // while content search is unreachable or still in
                      // flight, the names and paths already in hand are a
                      // real answer rather than a blank pane.
                      searchDocuments(columnView.documents, query).map((document) => ({ document }))
                    : withNameMatches(
                        hits.map((hit) => ({
                          document: hit.document,
                          contexts: hit.contexts,
                          ...(hit.lexicalRank === undefined
                            ? {}
                            : { lexicalRank: hit.lexicalRank }),
                          ...(hit.semanticRank === undefined
                            ? {}
                            : { semanticRank: hit.semanticRank }),
                        })),
                        columnView.documents,
                        query,
                      )
                }
                query={query}
                searchedContents={activeTag === null && hits !== null}
                selectedPath={selected?.path}
                onSelect={tapOpens ? openEntry : setSelected}
                onDocumentContextMenu={openCardMenu}
                renderThumbnail={(entry) => (
                  <DocumentThumbnail
                    key={entry.documentId}
                    document={entry}
                    loadRender={loadRender}
                    className="size-full"
                  />
                )}
              />
            </div>
          </div>
        )
      case 'browseOne':
        return (
          <div className="min-w-0 flex-1 overflow-y-auto md:border-r md:pr-3">
            <WorkspaceFileTree
              documents={columnView.documents}
              onOpen={tapOpens ? openEntry : setSelected}
              {...(onOpenDocument === undefined ? {} : { onActivate: openEntry })}
              onDocumentContextMenu={openCardMenu}
              selectedPath={selected?.path}
              renderIcon={(entry) => (
                <DocumentMinimap
                  key={entry.documentId}
                  document={entry}
                  loadOutline={loadOutline}
                />
              )}
            />
          </div>
        )
      case 'browseTwo':
        return (
          <>
            {/* Below md the folder column goes: the breadcrumb already walks
              the same hierarchy, and three columns in a phone's width
              leaves none of them readable. */}
            <div className="hidden w-56 shrink-0 overflow-y-auto border-r pr-3 md:block">
              <WorkspaceFolderTree
                documents={columnView.documents}
                onSelectFolder={selectFolder}
                selectedFolder={folder}
              />
            </div>
            <div className="min-w-0 flex-1 overflow-y-auto md:border-r md:pr-3">
              <div data-testid="folder-contents">
                <FolderContentsList
                  documents={columnView.documents}
                  folder={folder}
                  selectedPath={selected?.path}
                  onOpen={(target) =>
                    target.kind === 'folder'
                      ? selectFolder(target.path)
                      : selection !== null
                        ? toggleSelected(target.document)
                        : tapOpens
                          ? openEntry(target.document)
                          : setSelected(target.document)
                  }
                  {...(selection === null ? { selection: undefined } : { selection })}
                  {...(changed === undefined ? {} : { changed })}
                  {...(onOpenDocument === undefined || selection !== null
                    ? {}
                    : { onActivateDocument: openEntry })}
                  onDocumentContextMenu={openCardMenu}
                  renderThumbnail={(entry) => (
                    <DocumentThumbnail
                      key={entry.documentId}
                      document={entry}
                      loadRender={loadRender}
                      className="size-full"
                    />
                  )}
                />
              </div>
            </div>
          </>
        )
      default: {
        // A view this component can SELECT and cannot draw is a type error
        // here rather than a blank column area. Measured: adding a fifth arm
        // to `ColumnView` and a branch producing it fails with
        // `Type '{ kind: "timeline"; … }' is not assignable to type 'never'`;
        // adding the arm alone does not, because nothing can reach it.
        const unreachable: never = columnView
        return unreachable
      }
    }
  }

  return (
    // The panel names ITSELF, because the page heading above it now names the
    // workspace ("Mark as Switcher"). The generic word did not disappear when
    // it left the h1 — it moved to the region that actually holds the list,
    // which is where it was always true.
    <section
      ref={rootRef}
      aria-label="Documents"
      className="relative flex min-h-0 flex-1 flex-col gap-2"
      data-testid="workspace-files-panel"
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          {/* The trail belongs to whatever narrows the view. In one-column
              mode nothing does — the tree already shows every level at once —
              and while searching the results are from everywhere, so a trail
              would name a folder the list is not confined to. */}
          {columns === 'two' && query.trim() === '' && (
            <FolderBreadcrumb folder={folder} onSelect={selectFolder} />
          )}
        </div>
        <div className="relative shrink-0">
          <Search
            aria-hidden="true"
            className="text-muted-foreground pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2"
          />
          <input
            type="search"
            aria-label="Search documents"
            placeholder="Search"
            value={query}
            onChange={(event) => changeQuery(event.target.value)}
            className="w-36 rounded border py-1 pl-7 pr-2 text-xs sm:w-48"
          />
        </div>
        <NewDocumentMenu
          disabled={creating}
          workspace={workspace}
          defaultPath={derivedNewPath}
          createError={outcome.createRefusal?.reason ?? null}
          onCreate={createHere}
          onDismiss={outcome.dismissCreateRefusal}
        />
        <fieldset className="flex shrink-0 items-center gap-0.5 rounded border p-0.5">
          <legend className="sr-only">Column layout</legend>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="One column"
                aria-pressed={columns === 'one'}
                onClick={() => chooseColumns('one')}
                className="text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground rounded p-1"
              >
                <List className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>One column</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Two columns"
                aria-pressed={columns === 'two'}
                onClick={() => chooseColumns('two')}
                className="text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground rounded p-1"
              >
                <Columns2 className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Two columns</TooltipContent>
          </Tooltip>
        </fieldset>
      </div>

      {outcome.createRefusal !== null && (
        <p role="alert" className="text-destructive text-sm">
          Could not create a {outcome.createRefusal.kind} document here.
        </p>
      )}

      {outcome.pinRefusal !== null && (
        <p role="alert" className="text-destructive text-sm">
          Could not {outcome.pinRefusal.pinning ? 'pin' : 'unpin'} “{outcome.pinRefusal.path}”.{' '}
          {outcome.pinRefusal.reason}
        </p>
      )}

      {outcome.staleList !== null && (
        <p role="alert" className="text-destructive text-sm">
          {REFRESH_FAILURE_VERB[outcome.staleList.action]} “{outcome.staleList.path}”, but this list
          could not be refreshed. Reload to see it.
        </p>
      )}

      {workspaceTags.length > 0 && (
        /* The strip filters via the search box (#tag), so the filter stays
           visible, editable state rather than a hidden mode. */
        <TagStrip
          tags={workspaceTags}
          activeTag={activeTag}
          onToggle={(tag) => changeQuery(activeTag === tag ? '' : `#${tag}`)}
        />
      )}
      {selection !== null && (
        <div className="px-2 pb-2">
          <SelectionBar
            count={selection.size}
            onDelete={deleteSelected}
            onCancel={() => setSelection(null)}
          />
        </div>
      )}
      {/* Above the columns, and only in the browse view: a search has its
          own answer to "which one did you mean", and a lane beside it
          would compete with the results the person asked for. Absent on a
          host that cannot open a document, since every tile would be
          inert. */}
      {documents !== null && query.trim() === '' && onOpenDocument !== undefined && (
        <RecentLane
          documents={documents}
          recentIds={recentIds}
          onOpen={openEntry}
          renderThumbnail={(entry) => (
            <DocumentThumbnail
              key={entry.documentId}
              document={entry}
              loadRender={loadRender}
              className="size-full"
            />
          )}
        />
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
        {renderColumns()}
        {/* When a tap opens, selection can no longer fill this pane, so it
            would sit permanently on its empty state — below the grid on a
            phone, where it held the only Open button (the 2-tap bug). The
            long-press menu is the object surface on touch. */}
        {!tapOpens && (
          <div className="w-full shrink-0 overflow-y-auto md:w-72">
            <DocumentPreview
              document={selected}
              loadRender={loadRender}
              {...(onOpenDocument === undefined
                ? {}
                : { onOpen: (entry: WorkspaceDocumentEntry) => onOpenDocument(entry.path) })}
              onRename={(entry: WorkspaceDocumentEntry) => {
                rename.open(entry)
              }}
              {...(onDuplicateDocument === undefined
                ? {}
                : {
                    onDuplicate: (entry: WorkspaceDocumentEntry) => onDuplicateDocument(entry.path),
                  })}
              {...(onRequestDelete === undefined
                ? {}
                : {
                    onDelete: (entry: WorkspaceDocumentEntry) =>
                      onRequestDelete(entry.path, entry.name ?? entry.path, entry.kind),
                  })}
              className="h-full"
            />
          </div>
        )}
      </div>
      {/* Not while the list is loading. The trash is a SECOND list of the
          departed workspace's documents and reads on its own, so left
          mounted it keeps showing that workspace's rows under the new
          address until its own read answers — measured with a trash read
          that never answers, which is the window this closes. */}
      {documents !== null &&
        source.listTrash !== undefined &&
        source.restoreFromTrash !== undefined && (
          <TrashSection
            listTrash={source.listTrash.bind(source)}
            restoreFromTrash={source.restoreFromTrash.bind(source)}
            revision={revision}
            onRestored={() => {
              // A restore that landed but whose refresh failed leaves the list
              // stale, not the restore undone — same rule as every other write
              // here, so the trash section never invents its own error shape.
              void readList().then(setDocuments, () => undefined)
            }}
          />
        )}
      <PeekDialog
        document={peek}
        loadRender={loadRender}
        onOpen={openEntry}
        onClose={() => setPeek(null)}
      />
      <RenameDocumentDialog
        document={rename.renaming}
        workspace={workspace}
        busy={rename.busy}
        error={rename.error}
        onCancel={rename.cancel}
        onSubmit={(name, newPath) => {
          if (rename.renaming === null) return
          void rename.submit(rename.renaming, name, newPath)
        }}
      />
      {cardMenu !== null && (
        <ContextMenu
          x={cardMenu.x}
          y={cardMenu.y}
          label="Document actions"
          items={cardMenuItems}
          onClose={() => setCardMenu(null)}
          variant={hasCoarsePointer() ? 'sheet' : 'list'}
        />
      )}
    </section>
  )
}
