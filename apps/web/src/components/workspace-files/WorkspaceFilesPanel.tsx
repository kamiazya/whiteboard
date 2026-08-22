import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { Columns2, List, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useThemeMode } from '../../hooks/useThemeMode.js'
import { ContextMenu } from '../spatial-editor/ContextMenu.js'
import { DocumentMinimap } from './DocumentMinimap.js'
import { DocumentPreview } from './DocumentPreview.js'
import { DocumentThumbnail } from './DocumentThumbnail.js'
import type { WorkspaceDocumentEntry } from './document-entry.js'
import { FolderBreadcrumb } from './FolderBreadcrumb.js'
import { FolderContentsList } from './FolderContentsList.js'
import { type WorkspaceFilesSource, WorkspaceMissingError } from './files-source.js'
import { createRowOutlineLoader } from './load-row-outline.js'
import { createRowRenderLoader } from './load-row-render.js'
import { NewDocumentMenu } from './NewDocumentMenu.js'
import { newDocumentPathIn } from './new-document-path.js'
import { RenameDocumentDialog } from './RenameDocumentDialog.js'
import { SearchResults } from './SearchResults.js'
import { searchDocuments } from './search-documents.js'
import { WorkspaceFileTree } from './WorkspaceFileTree.js'
import { WorkspaceFolderTree } from './WorkspaceFolderTree.js'

export interface WorkspaceFilesPanelProps {
  /**
   * Where the documents live. The panel itself no longer knows which mode it
   * is in — the daemon and the browser-local store each supply one of these,
   * which is what lets one browser serve both.
   */
  source: WorkspaceFilesSource
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
 * How many columns stand between the workspace and the preview.
 *
 * `one` is the whole tree — folders and documents together, reachable
 * without moving anything, which is what you want when you know where you
 * are going. `two` splits it: folders on the left, that folder's contents
 * as cards beside them, which is what you want when you are looking rather
 * than navigating. Neither is a subset of the other, which is why this is a
 * toggle and not a width breakpoint.
 */
export type BrowserColumns = 'one' | 'two'

const COLUMNS_STORAGE_KEY = 'whiteboard.document-browser.columns.v1'

/**
 * The column count is a per-device PREFERENCE, deliberately not part of the
 * address: a link someone shares must not impose the sender's layout on
 * whoever opens it. The open folder is the other side of that line — it is
 * what you are looking at, so it lives in the URL.
 *
 * Every access is guarded because storage does not merely come back empty
 * when it is unavailable — a private window or blocked site data makes the
 * accessor itself throw — and because nothing stops the stored value being
 * anything at all.
 */
function readStoredColumns(): BrowserColumns {
  try {
    return globalThis.localStorage?.getItem(COLUMNS_STORAGE_KEY) === 'one' ? 'one' : 'two'
  } catch {
    return 'two'
  }
}

function storeColumns(next: BrowserColumns): void {
  try {
    globalThis.localStorage?.setItem(COLUMNS_STORAGE_KEY, next)
  } catch {
    // A remembered layout is a courtesy; losing it must never break the view.
  }
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
  onOpenDocument,
  initialFolder,
  onFolderChange,
  onDuplicateDocument,
  onRequestDelete,
  revision,
}: WorkspaceFilesPanelProps) {
  const { resolvedTheme } = useThemeMode()
  const [documents, setDocuments] = useState<readonly WorkspaceDocumentEntry[] | null>(null)
  // 'not-found' is a workspace with no v1 tree yet — a calm empty state, not
  // a failure. 'error' is a genuine fetch/schema failure and keeps the alert.
  const [listStatus, setListStatus] = useState<'ok' | 'not-found' | 'error'>('ok')
  const [selected, setSelected] = useState<WorkspaceDocumentEntry | null>(null)
  // '' is the workspace root, which is where a freshly loaded tree starts —
  // unless the address named a folder, which is the whole point of naming it.
  const [folder, setFolder] = useState(initialFolder ?? '')
  const [columns, setColumns] = useState<BrowserColumns>(readStoredColumns)
  const [createError, setCreateError] = useState<string | null>(null)
  // The `disabled` attribute is the whole double-press mechanism: React
  // flushes this state before a second click can dispatch, while a
  // handler-side early return would read a stale closure in exactly the
  // same-tick case it exists to catch.
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  // The object-action menu: which document was right-clicked, and where.
  const [cardMenu, setCardMenu] = useState<{
    entry: WorkspaceDocumentEntry
    x: number
    y: number
  } | null>(null)
  // The rename dialog's target, plus the in-flight/refusal state its form
  // shows. Null means closed.
  const [renaming, setRenaming] = useState<WorkspaceDocumentEntry | null>(null)
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  // Every tag in the workspace, each once, in reading order. The strip is
  // derived — deleting the last carrier of a tag removes its chip with it.
  const workspaceTags = useMemo(() => {
    const seen = new Set<string>()
    for (const entry of documents ?? []) for (const tag of entry.tags ?? []) seen.add(tag)
    return [...seen].sort((a, b) => a.localeCompare(b))
  }, [documents])
  const activeTag = query.trim().startsWith('#') ? query.trim().slice(1) : null

  // One loader for the whole panel, so a re-render does not hand every card
  // a new function and re-trigger its render.
  const loadRender = useMemo(
    () => createRowRenderLoader({ source, theme: resolvedTheme }),
    [source, resolvedTheme],
  )

  // The row-size rendition. Separate from `loadRender` on purpose: it asks
  // the worker for block geometry rather than a serialized SVG, which is
  // both cheaper and the only thing legible at 24px (see DocumentMinimap).
  const loadOutline = useMemo(() => createRowOutlineLoader({ source }), [source])

  const readList = useCallback(() => source.listDocuments(), [source])

  // Through a ref so it never joins an effect's dependencies: a host that
  // passes an inline arrow would otherwise re-run the workspace-load effect
  // on every render of the page above.
  const onFolderChangeRef = useRef(onFolderChange)
  onFolderChangeRef.current = onFolderChange
  // Same reason as the folder callback: kept out of createHere's dependency
  // list so an inline arrow from the page above cannot re-create it.
  const onOpenDocumentRef = useRef(onOpenDocument)
  onOpenDocumentRef.current = onOpenDocument
  const lastReadListRef = useRef(readList)

  const chooseColumns = (next: BrowserColumns) => {
    setColumns(next)
    storeColumns(next)
  }

  useEffect(() => {
    let cancelled = false
    setDocuments(null)
    setListStatus('ok')
    setSelected(null)
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
    readList()
      .then((entries) => {
        if (!cancelled) setDocuments(entries)
      })
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
  useEffect(() => {
    if (revision === undefined) return
    let cancelled = false
    readList()
      .then((entries) => {
        if (cancelled) return
        setDocuments(entries)
        setSelected((current) =>
          current === null ? null : (entries.find((row) => row.path === current.path) ?? null),
        )
        // An open context menu is a captured snapshot; a refresh behind the
        // panel's back (the whole reason `revision` exists) re-resolves it
        // the same way, and a menu whose document is GONE closes rather
        // than offering verbs for a target that no longer exists.
        setCardMenu((current) => {
          if (current === null) return null
          const entry = entries.find((row) => row.path === current.entry.path)
          return entry === undefined ? null : { ...current, entry }
        })
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
      setCreateError(null)
      setCreating(true)
      try {
        // No options means nobody expressed an opinion, so the address is
        // derived exactly as it always was. The dialog is the only caller
        // that supplies one.
        const path = options?.path ?? derivedNewPath
        await source.createDocument(path, kind, options?.name)
        const entries = await readList()
        setDocuments(entries)
        setSelected(entries.find((row) => row.path === path) ?? null)
        // Creating exists to produce content, and an empty document is worth
        // nothing until it is open — so the create ends where the next thing
        // happens, as every other creation path in the app already did.
        //
        // Only affordable because the open folder is in the address now: the
        // way back returns to the folder this was made in, rather than to
        // the workspace root. The selection above still lands, so a host
        // that offers no way to open leaves someone looking at the new
        // document rather than at nothing.
        onOpenDocumentRef.current?.(path)
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
  const submitRename = useCallback(
    async (entry: WorkspaceDocumentEntry, name: string | undefined, newPath: string) => {
      setRenameBusy(true)
      setRenameError(null)
      try {
        if ((entry.name ?? undefined) !== name) {
          await source.setDocumentName(entry, name)
        }
        if (newPath !== entry.path) {
          await moveDocumentRef.current(entry, newPath)
        } else {
          const entries = await readList()
          setDocuments(entries)
          setSelected(entries.find((row) => row.path === entry.path) ?? null)
        }
        setRenaming(null)
      } catch (err) {
        // The server names the PRODUCED path that collided, which on a
        // subtree move is often not the one typed here.
        setRenameError(err instanceof Error ? err.message : 'Could not rename it.')
        // A rename applies two writes; the first may have landed before the
        // second was refused. Re-reading here is what stops the panel from
        // showing a name the store no longer holds — the refusal is about
        // the path, and the rest of the screen must still be true.
        try {
          const entries = await readList()
          setDocuments(entries)
          setSelected(entries.find((row) => row.path === entry.path) ?? null)
        } catch {
          // The list read failing on top of a failed rename leaves what is
          // already on screen; the dialog's own message is the report.
        }
      } finally {
        setRenameBusy(false)
      }
    },
    [source, readList],
  )

  const moveDocument = useCallback(
    async (entry: WorkspaceDocumentEntry, newPath: string) => {
      await source.renameDocumentPath(entry.path, newPath)
      const entries = await readList()
      setDocuments(entries)
      setSelected(entries.find((row) => row.path === newPath) ?? null)
      const landedIn = newPath.includes('/') ? newPath.slice(0, newPath.lastIndexOf('/')) : ''
      setFolder(landedIn)
      onFolderChangeRef.current?.(landedIn)
    },
    [source, readList],
  )
  // submitRename is declared above moveDocument (it reads better beside the
  // dialog state) and calls it through a ref rather than being reordered:
  // both are hooks, so their ORDER is load-bearing and a reader should not
  // have to verify it twice.
  const moveDocumentRef = useRef(moveDocument)
  moveDocumentRef.current = moveDocument

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
  if (documents === null) {
    return <p className="text-muted-foreground text-sm">Loading files…</p>
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
            : [{ label: 'Open', onSelect: () => onOpenDocument(cardMenu.entry.path) }]),
          ...(onDuplicateDocument === undefined
            ? []
            : [{ label: 'Duplicate', onSelect: () => onDuplicateDocument(cardMenu.entry.path) }]),
          {
            label: 'Rename…',
            onSelect: () => {
              setSelected(cardMenu.entry)
              setRenameError(null)
              setRenaming(cardMenu.entry)
            },
          },
          ...(onRequestDelete === undefined
            ? []
            : [
                {
                  label: 'Delete',
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

  return (
    <div
      ref={rootRef}
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
          defaultPath={derivedNewPath}
          onCreate={(kind, options) =>
            void createHere(kind, options).catch(() => setCreateError(kind))
          }
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

      {createError !== null && (
        <p role="alert" className="text-destructive text-sm">
          Could not create a {createError} document here.
        </p>
      )}

      {workspaceTags.length > 0 && (
        /* The one place tag chips are BUTTONS: rows are buttons already,
           and a button inside a button is neither valid nor reachable by
           keyboard. The strip filters via the search box (#tag), so the
           filter stays visible, editable state rather than a hidden mode. */
        <fieldset aria-label="Filter by tag" className="flex flex-wrap gap-1 border-0 px-2 pb-1">
          {workspaceTags.map((tag) => (
            <button
              key={tag}
              type="button"
              aria-pressed={activeTag === tag}
              onClick={() => changeQuery(activeTag === tag ? '' : `#${tag}`)}
              className="text-muted-foreground hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground rounded-full border px-2 py-0.5 text-[11px]"
            >
              #{tag}
            </button>
          ))}
        </fieldset>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
        {query.trim() !== '' ? (
          // Results come from everywhere, so neither the folder tree nor the
          // folder's own contents describes them. One flat list, in both
          // column modes — a search that behaved differently per mode would
          // be two features wearing one box.
          <div className="min-w-0 flex-1 overflow-y-auto md:border-r md:pr-3">
            <div data-testid="search-results">
              <SearchResults
                results={searchDocuments(documents, query)}
                query={query}
                selectedPath={selected?.path}
                onSelect={setSelected}
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
        ) : columns === 'one' ? (
          <div className="min-w-0 flex-1 overflow-y-auto md:border-r md:pr-3">
            <WorkspaceFileTree
              documents={documents}
              onOpen={setSelected}
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
        ) : (
          <>
            {/* Below md the folder column goes: the breadcrumb already walks
                the same hierarchy, and three columns in a phone's width
                leaves none of them readable. */}
            <div className="hidden w-56 shrink-0 overflow-y-auto border-r pr-3 md:block">
              <WorkspaceFolderTree
                documents={documents}
                onSelectFolder={selectFolder}
                selectedFolder={folder}
              />
            </div>
            <div className="min-w-0 flex-1 overflow-y-auto md:border-r md:pr-3">
              <div data-testid="folder-contents">
                <FolderContentsList
                  documents={documents}
                  folder={folder}
                  selectedPath={selected?.path}
                  onOpen={(target) =>
                    target.kind === 'folder'
                      ? selectFolder(target.path)
                      : setSelected(target.document)
                  }
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
        )}
        <div className="w-full shrink-0 overflow-y-auto md:w-72">
          <DocumentPreview
            document={selected}
            loadRender={loadRender}
            {...(onOpenDocument === undefined
              ? {}
              : { onOpen: (entry: WorkspaceDocumentEntry) => onOpenDocument(entry.path) })}
            onRename={(entry: WorkspaceDocumentEntry) => {
              setRenameError(null)
              setRenaming(entry)
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
      </div>
      <RenameDocumentDialog
        document={renaming}
        busy={renameBusy}
        error={renameError}
        onCancel={() => {
          setRenaming(null)
          setRenameError(null)
        }}
        onSubmit={(name, newPath) => {
          if (renaming === null) return
          void submitRename(renaming, name, newPath)
        }}
      />
      {cardMenu !== null && (
        <ContextMenu
          x={cardMenu.x}
          y={cardMenu.y}
          label="Document actions"
          items={cardMenuItems}
          onClose={() => setCardMenu(null)}
        />
      )}
    </div>
  )
}
